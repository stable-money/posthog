from django.db import models

from posthog.models.organization import OrganizationMembership
from posthog.models.utils import UUIDTModel, sane_repr


# DEPRECATED - do not use
class ExplicitTeamMembership(UUIDTModel):
    class Level(models.IntegerChoices):
        """Keep in sync with OrganizationMembership.Level (only difference being organizations having an Owner)."""

        MEMBER = 1, "member"
        ADMIN = 8, "administrator"

    team = models.ForeignKey(
        "posthog.Team",
        on_delete=models.CASCADE,
        related_name="explicit_memberships",
        related_query_name="explicit_membership",
    )
    parent_membership = models.ForeignKey(
        "posthog.OrganizationMembership",
        on_delete=models.CASCADE,
        related_name="explicit_team_memberships",
        related_query_name="explicit_team_membership",
    )
    level = models.PositiveSmallIntegerField(default=Level.MEMBER, choices=Level)
    joined_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # Pinned to the "ee" app so the table stays ee_explicitteammembership and the existing
        # ee migration graph keeps applying -- moving the file is a licence move, not a schema
        # change. Same pattern as products/access_control/backend/models/role.py.
        app_label = "ee"
        constraints = [
            models.UniqueConstraint(
                fields=["team", "parent_membership"],
                name="unique_explicit_team_membership",
            )
        ]

    def __str__(self) -> str:
        return str(self.Level(self.level))

    @property
    def effective_level(self) -> "OrganizationMembership.Level":
        """If organization level is higher than project level, then that takes precedence over explicit project level."""
        return OrganizationMembership.Level(max(self.level, self.parent_membership.level))

    __repr__ = sane_repr("team", "parent_membership", "level")
