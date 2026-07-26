from app.routers import generate_api_test, generate_unit, jobs
from app.features.generation.integration import router as integration_router

routers = [
    jobs.router,
    generate_unit.router,
    generate_api_test.router,
    integration_router,
]

__all__ = ["routers"]
