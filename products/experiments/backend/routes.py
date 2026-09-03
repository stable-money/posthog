from posthog.api.routing import RouterRegistry
from posthog.settings import EE_AVAILABLE


def register_routes(routers: RouterRegistry) -> None:
    # All three viewsets now live under products/, so nothing here imports ee/ any more.
    # The gate is kept deliberately: dropping it would newly expose /experiments/,
    # /experiment_holdouts/ and /experiment_saved_metrics/ on a build without EE, which is a
    # product decision rather than a consequence of relocating the source.
    if not EE_AVAILABLE:
        return

    from products.experiments.backend.presentation.holdouts import ExperimentHoldoutViewSet
    from products.experiments.backend.presentation.saved_metrics import ExperimentSavedMetricViewSet
    from products.experiments.backend.presentation.views import EnterpriseExperimentsViewSet

    routers.projects.register(r"experiments", EnterpriseExperimentsViewSet, "project_experiments", ["project_id"])
    routers.projects.register(
        r"experiment_holdouts", ExperimentHoldoutViewSet, "project_experiment_holdouts", ["project_id"]
    )
    routers.projects.register(
        r"experiment_saved_metrics", ExperimentSavedMetricViewSet, "project_experiment_saved_metrics", ["project_id"]
    )
