"""Tests for AItest output layout - pattern-based, no real project names.

Monorepo rule: source under {pkg}/src|lib -> write under {pkg}/AItest
(and Desktop stages under {pkg}/.ai-test). Never leave AItest at monorepo root
for nested packages.
"""
from __future__ import annotations

import unittest

from app.services.test_output_layout import (
    AITEST_ROOT,
    assert_safe_aitest_target_rel,
    coverage_dir,
    metadata_path,
    module_rel_from_source,
    package_prefix_from_source,
    reports_dir,
    rewrite_sut_imports,
    file_name_from_source,
    under_generated_test_folder,
)


class TestOutputLayout(unittest.TestCase):
    def test_module_from_source_strips_src(self):
        self.assertEqual(
            module_rel_from_source("src/Order/Services/OrderService.cs"),
            "Order/Services",
        )

    def test_module_strips_spa_shell_segments(self):
        self.assertEqual(
            module_rel_from_source(
                "product-a/WebSpa/src/app/admin/feature-x/update/widget.component.ts"
            ),
            "product-a/update",
        )

    def test_nested_package_gets_own_aitest(self):
        """BE/FE style: {pkg}/src/… → {pkg}/AItest/… (not monorepo-root AItest)."""
        cases = [
            (
                "svc-api/src/todos/todos.service.ts",
                "Todo",
                "todos.service.test.ts",
                "svc-api/AItest/UnitTest/Todo/todos.service.test.ts",
            ),
            (
                "web-app/src/pages/home.tsx",
                "Home",
                "home.test.tsx",
                "web-app/AItest/UnitTest/Home/home.test.tsx",
            ),
            (
                "org-z/services/billing/src/invoice.ts",
                "Billing",
                "invoice.test.ts",
                "org-z/services/billing/AItest/UnitTest/Billing/invoice.test.ts",
            ),
        ]
        for src, module, name, expected in cases:
            with self.subTest(src=src):
                self.assertEqual(package_prefix_from_source(src), expected.split("/AItest/")[0])
                path = under_generated_test_folder(
                    "unit", name, source_file_name=src, module=module
                )
                self.assertEqual(path, expected)
                self.assertFalse(path.startswith(f"{AITEST_ROOT}/"))

    def test_spa_under_product_nests_aitest_in_spa_package(self):
        path = under_generated_test_folder(
            "unit",
            "widget.component.test.ts",
            source_file_name=(
                "product-a/WebSpa/src/app/admin/feature-x/update/widget.component.ts"
            ),
            module="FeatureX",
        )
        self.assertEqual(
            path,
            "product-a/WebSpa/AItest/UnitTest/FeatureX/widget.component.test.ts",
        )
        after = path.lower().split("/aitest/", 1)[-1]
        self.assertNotIn("webspa/", after)
        self.assertNotIn("src/", after)

    def test_src_at_apply_root_uses_root_aitest(self):
        """Single-package repo: src/… → AItest/… at apply root is correct."""
        path = under_generated_test_folder(
            "unit",
            "OrderServiceTests.cs",
            source_file_name="src/Order/Services/OrderService.cs",
        )
        self.assertEqual(path, "AItest/UnitTest/Order/Services/OrderServiceTests.cs")

    def test_package_prefix_override(self):
        path = under_generated_test_folder(
            "unit",
            "x.test.ts",
            source_file_name="svc-api/src/todos/x.ts",
            module="Todo",
            package_prefix="svc-api",
        )
        self.assertEqual(path, "svc-api/AItest/UnitTest/Todo/x.test.ts")
        # Explicit empty only for true single-root packages
        path_root = under_generated_test_folder(
            "unit",
            "x.test.ts",
            source_file_name="src/todos/x.ts",
            module="Todo",
            package_prefix="",
        )
        self.assertEqual(path_root, "AItest/UnitTest/Todo/x.test.ts")

    def test_relative_import_from_package_aitest(self):
        src = "svc-api/src/todos/todos.service.ts"
        path = under_generated_test_folder(
            "unit",
            "todos.service.test.ts",
            source_file_name=src,
            module="Todo",
        )
        from app.services.test_output_layout import sut_module_specifier

        self.assertEqual(sut_module_specifier(path, src), "src/todos/todos.service")
        fixed = rewrite_sut_imports(
            "import { TodosService } from '../todos.service';\n"
            "import { TodosService as T2 } from '../../../src/todos/todos.service';\n",
            test_rel=path,
            source_rel=src,
        )
        self.assertIn("from 'src/todos/todos.service'", fixed)
        self.assertNotIn("../../../src/", fixed)

    def test_api_folder_name(self):
        path = under_generated_test_folder(
            "api",
            "UserControllerApiTests.cs",
            source_file_name="src/User/Controllers/UserController.cs",
        )
        self.assertEqual(path, "AItest/APITest/User/Controllers/UserControllerApiTests.cs")

    def test_integration_kind(self):
        path = under_generated_test_folder(
            "integration",
            "OrderFlowTests.cs",
            module="Order",
        )
        self.assertEqual(path, "AItest/IntegrationTest/Order/OrderFlowTests.cs")

    def test_tc_module_wins_over_source(self):
        path = under_generated_test_folder(
            "unit",
            "OrderServiceTests.cs",
            source_file_name="src/Order/Services/OrderService.cs",
            module="Đăng nhập",
        )
        self.assertEqual(path, "AItest/UnitTest/Đăng nhập/OrderServiceTests.cs")

    def test_fallback_tc_module(self):
        path = under_generated_test_folder(
            "unit",
            "FooTests.cs",
            module="Order",
        )
        self.assertEqual(path, "AItest/UnitTest/Order/FooTests.cs")

    def test_never_beside_go_source(self):
        path = under_generated_test_folder(
            "unit",
            "order_test.go",
            source_file_name="internal/order/order.go",
        )
        self.assertEqual(path, "AItest/UnitTest/order/order_test.go")
        self.assertFalse(path.startswith("internal/"))

    def test_naming(self):
        self.assertEqual(
            file_name_from_source(
                "OrderService.cs", language="C#", class_name="OrderService"
            ),
            "OrderServiceTests.cs",
        )
        self.assertEqual(
            file_name_from_source("ProductService.ts", language="TypeScript"),
            "ProductService.test.ts",
        )
        self.assertEqual(
            file_name_from_source("payment_service.py", language="Python"),
            "test_payment_service.py",
        )

    def test_rewrite_sut_imports_alias_and_relative(self):
        code = (
            "import { X } from '@/todos/todos.service';\n"
            "import { Y } from '../../../src/todos/todos.service';\n"
            "import { Z } from '@nestjs/common';\n"
        )
        fixed = rewrite_sut_imports(
            code,
            test_rel="svc/AItest/UnitTest/T/x.test.ts",
            source_rel="svc/src/todos/todos.service.ts",
        )
        self.assertIn("src/todos/todos.service", fixed)
        self.assertNotIn("@/todos", fixed)
        self.assertNotIn("../", fixed)
        self.assertIn("@nestjs/common", fixed)

    def test_rewrite_secondary_relative_imports(self):
        code = (
            "import { AuthService } from './auth.service';\n"
            "import { CreateUserDto } from './dto/create-user.dto';\n"
            "import { UserEntity } from '../entities/user.entity';\n"
        )
        fixed = rewrite_sut_imports(
            code,
            test_rel="AItest/UnitTest/Auth/auth.service.spec.ts",
            source_rel="src/auth/auth.service.ts",
        )
        self.assertIn("import { AuthService } from 'src/auth/auth.service';", fixed)
        self.assertIn("import { CreateUserDto } from 'src/auth/dto/create-user.dto';", fixed)
        self.assertIn("import { UserEntity } from 'src/entities/user.entity';", fixed)

    def test_support_dirs(self):
        self.assertEqual(reports_dir(), "AItest/Reports")
        self.assertEqual(coverage_dir(), "AItest/Coverage")
        self.assertEqual(metadata_path("run-1"), "AItest/Metadata/run-1.json")

    def test_p5_path_jail(self):
        self.assertEqual(
            assert_safe_aitest_target_rel("AItest/UnitTest/Order/FooTests.cs"),
            "AItest/UnitTest/Order/FooTests.cs",
        )
        self.assertEqual(
            assert_safe_aitest_target_rel("svc-api/AItest/UnitTest/Todo/x.test.ts"),
            "svc-api/AItest/UnitTest/Todo/x.test.ts",
        )
        self.assertEqual(
            assert_safe_aitest_target_rel(
                "product-a/WebSpa/AItest/UnitTest/FeatureX/x.test.ts"
            ),
            "product-a/WebSpa/AItest/UnitTest/FeatureX/x.test.ts",
        )
        with self.assertRaises(ValueError):
            assert_safe_aitest_target_rel("src/FooTests.cs")
        with self.assertRaises(ValueError):
            assert_safe_aitest_target_rel("AItest/../x.cs")
        with self.assertRaises(ValueError):
            assert_safe_aitest_target_rel("AItest/UnitTest/WebSpa/src/app/x.test.ts")


if __name__ == "__main__":
    unittest.main()
