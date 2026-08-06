"""Phase 2 Test Planner — mirror of desktop testPlanner."""

from app.services.test_planner import analyze_intent, extract_feature_path, plan_from_test_case


def test_extract_feature_path():
    assert extract_feature_path({"testData": "path: /orders/new"}) == "/orders/new"


def test_plan_unit_from_type():
    plan = plan_from_test_case(
        {
            "title": "CreateOrder validates inventory",
            "type": "Unit",
            "module": "Order",
            "steps": "Mock InventoryService; Call OrderService.create; Assert",
        },
        requirement={"featureNames": ["Order", "Payment"]},
    )
    assert plan["testType"] == "Unit"
    assert plan["module"] == "Order"
    assert plan["keywords"]
    assert plan["hints"]["confidence"] >= 0.85


def test_plan_e2e_from_path_and_ui():
    plan = plan_from_test_case(
        {
            "title": "Checkout",
            "type": "",
            "testData": "path: /checkout",
            "steps": "Click Place order; see toast",
        }
    )
    assert plan["testType"] == "E2E"
    assert plan["hints"].get("e2eStack") == "playwright"
    assert plan["hints"].get("featurePath") == "/checkout"


def test_force_test_type():
    plan = plan_from_test_case(
        {"title": "X", "type": "E2E", "testData": "path: /a", "steps": "click"},
        force_test_type="Unit",
    )
    assert plan["testType"] == "Unit"


def test_fixture_accuracy_at_least_90_percent():
    fixtures = [
        ({"title": "A", "type": "Unit", "steps": "mock assert"}, "Unit"),
        (
            {
                "title": "B",
                "type": "E2E",
                "testData": "path: /login",
                "steps": "click login",
            },
            "E2E",
        ),
        (
            {
                "title": "C",
                "type": "API",
                "steps": "POST /api/orders status code 201",
            },
            "API",
        ),
        (
            {
                "title": "D",
                "type": "Integration",
                "steps": "integration across services",
            },
            "Integration",
        ),
        (
            {
                "title": "E",
                "type": "",
                "testData": "path: /cart",
                "steps": "fill form click submit",
            },
            "E2E",
        ),
        (
            {
                "title": "F",
                "type": "Functional",
                "steps": "Arrange SUT; Act; Assert",
            },
            "Unit",
        ),
        (
            {
                "title": "G",
                "type": "",
                "steps": "mock repository assert throws",
            },
            "Unit",
        ),
        (
            {
                "title": "H",
                "type": "E2E-Validation",
                "steps": "navigate goto page",
                "testData": "path: /x",
            },
            "E2E",
        ),
        (
            {
                "title": "I",
                "type": "API",
                "steps": "GET /api/users endpoint",
            },
            "API",
        ),
        (
            {
                "title": "J",
                "type": "Unit",
                "module": "Shared",
                "steps": "call helper",
            },
            "Unit",
        ),
    ]
    ok = 0
    for tc, expect in fixtures:
        got = analyze_intent(tc)["testType"]
        if got == expect:
            ok += 1
    assert ok / len(fixtures) >= 0.9, f"{ok}/{len(fixtures)}"
