import { PostgresRouter, PostgresUse } from '~/common/utils/db/postgres'
import { LazyLoader } from '~/common/utils/lazy-loader'
import { logger } from '~/common/utils/logger'

// Mirrors EmailTrackingConsentMode in products/workflows/backend/models/team_workflows_config.py
export type EmailTrackingConsentMode = 'off' | 'opt_out' | 'opt_in'

export type TeamWorkflowsConfig = {
    capture_workflows_engagement_events: boolean
    email_tracking_consent_mode: EmailTrackingConsentMode
    email_sending_suspended: boolean
    /** Trust tier that picks the team's hourly and daily workflow email caps. */
    email_sending_tier: number
    /** Creation date of the team, so enforcement can be narrowed to teams created after a cutoff. */
    team_created_at: string | null
}

const DEFAULT_CONFIG: TeamWorkflowsConfig = {
    capture_workflows_engagement_events: false,
    email_tracking_consent_mode: 'off',
    email_sending_suspended: false,
    email_sending_tier: 0,
    team_created_at: null,
}

export type TeamEmailSendingTier = {
    tier: number
    teamCreatedAt: string | null
}

/**
 * Reads `workflows_teamworkflowsconfig` rows. The Django side creates a row
 * lazily via `get_or_create_team_extension`, so a missing row means the team
 * has never opted in — return the default (engagement event capture off).
 */
export class TeamWorkflowsConfigService {
    private lazyLoader: LazyLoader<TeamWorkflowsConfig>

    constructor(private postgres: PostgresRouter) {
        this.lazyLoader = new LazyLoader({
            name: 'team_workflows_config',
            refreshAgeMs: 2 * 60 * 1000,
            refreshJitterMs: 30 * 1000,
            loader: async (teamIds) => await this.fetchConfigs(teamIds),
        })
    }

    public async get(teamId: number): Promise<TeamWorkflowsConfig> {
        return (await this.lazyLoader.get(String(teamId))) ?? DEFAULT_CONFIG
    }

    public async shouldCaptureEngagementEvents(teamId: number): Promise<boolean> {
        const config = await this.get(teamId)
        return config.capture_workflows_engagement_events
    }

    public async getEmailTrackingConsentMode(teamId: number): Promise<EmailTrackingConsentMode> {
        const config = await this.get(teamId)
        return config.email_tracking_consent_mode
    }

    /**
     * Team-level kill switch, set by staff when a team's sender reputation puts shared SES
     * deliverability at risk. Fails open: a lookup error must never block legitimate sends.
     */
    public async isEmailSendingSuspended(teamId: number): Promise<boolean> {
        try {
            const config = await this.get(teamId)
            return config.email_sending_suspended
        } catch (error) {
            logger.error('[TeamWorkflowsConfig] Failed to check email sending suspension', { teamId, error })
            return false
        }
    }

    /**
     * Trust tier for the team's workflow email, which the send path turns into an hourly and a
     * daily cap. Fails open with `null`: a lookup error must let the send through rather than
     * throttle a legitimate customer, same stance as `isEmailSendingSuspended`.
     */
    public async getEmailSendingTier(teamId: number): Promise<TeamEmailSendingTier | null> {
        try {
            const config = await this.get(teamId)
            return { tier: config.email_sending_tier, teamCreatedAt: config.team_created_at }
        } catch (error) {
            logger.error('[TeamWorkflowsConfig] Failed to read email sending tier', { teamId, error })
            return null
        }
    }

    private async fetchConfigs(teamIds: string[]): Promise<Record<string, TeamWorkflowsConfig>> {
        // Joined to posthog_team rather than read separately: the tier cap can be scoped to teams
        // created after a cutoff, and the send path needs both values in the same cached entry.
        const result = await this.postgres.query<{
            team_id: number
            capture_workflows_engagement_events: boolean
            email_tracking_consent_mode: EmailTrackingConsentMode
            email_sending_suspended: boolean
            email_sending_tier: number
            team_created_at: string | null
        }>(
            PostgresUse.COMMON_READ,
            `SELECT c.team_id, c.capture_workflows_engagement_events, c.email_tracking_consent_mode,
                    c.email_sending_suspended_at IS NOT NULL AS email_sending_suspended,
                    c.email_sending_tier,
                    t.created_at AS team_created_at
             FROM workflows_teamworkflowsconfig c
             LEFT JOIN posthog_team t ON t.id = c.team_id
             WHERE c.team_id = ANY($1)`,
            [teamIds.map(Number)],
            'fetch-team-workflows-configs'
        )

        const configs: Record<string, TeamWorkflowsConfig> = {}
        for (const teamId of teamIds) {
            configs[teamId] = DEFAULT_CONFIG
        }
        for (const row of result.rows) {
            configs[String(row.team_id)] = {
                capture_workflows_engagement_events: row.capture_workflows_engagement_events,
                email_tracking_consent_mode: row.email_tracking_consent_mode ?? 'off',
                email_sending_suspended: row.email_sending_suspended,
                email_sending_tier: row.email_sending_tier ?? 0,
                team_created_at: row.team_created_at ?? null,
            }
        }
        return configs
    }
}
