"""Tests for AItest output layout — pattern fixtures, NOT a real customer project.

Layout rule (any repo name):
  source under {pkg}/src|lib → write under {pkg}/AItest
  single-package src/… → AItest/… at apply root

Customize shells/markers without code edits:
  AITEST_SPA_SHELLS=webspa,myshell
  AITEST_CODE_ROOT_MARKERS=src,lib,libs,app
  AITEST_STRUCTURAL_SEGMENTS=src,lib,… (optional merge)
"""
from __future__ import annotations

import os
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
    sanitize_path_segment,
    shorten_e2e_rel_path,
    under_generated_test_folder,
)


class TestOutputLayout(unittest.TestCase):
    def test_module_from_source_strips_src(self):
        self.assertEqual(
            module_rel_from_source("src/Order/Services/OrderService.cs"),
            "Order/Services",
        )

    def test_module_strips_spa_shell_keeps_business_leaf(self):
        # Fixture shape only — any product/{SpaShell}/src/app/… works the same
        self.assertEqual(
            module_rel_from_source(
                "product-a/WebSpa/src/app/admin/feature-x/update/widget.component.ts"
            ),
            "feature-x/update",
        )

    def test_nested_package_gets_own_aitest(self):
        """{anyPkg}/src/… → {anyPkg}/AItest/… (not monorepo-root AItest)."""
        cases = [
            (
                "pkg-api/src/orders/orders.service.ts",
                "Orders",
                "orders.service.test.ts",
                "pkg-api/AItest/UnitTest/Orders/orders.service.test.ts",
            ),
            (
                "pkg-web/src/pages/home.tsx",
                "Home",
                "home.test.tsx",
                "pkg-web/AItest/UnitTest/Home/home.test.tsx",
            ),
            (
                "org/services/billing/src/invoice.ts",
                "Billing",
                "invoice.test.ts",
                "org/services/billing/AItest/UnitTest/Billing/invoice.test.ts",
            ),
            (
                "backend/src/Users/UserService.cs",
                "Users",
                "UserServiceTests.cs",
                "backend/AItest/UnitTest/Users/UserServiceTests.cs",
            ),
            (
                "frontend/src/features/checkout/cart.ts",
                "Checkout",
                "cart.test.ts",
                "frontend/AItest/UnitTest/Checkout/cart.test.ts",
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

    def test_package_prefix_override_any_name(self):
        """FS discovery can force any package name — works across projects."""
        path = under_generated_test_folder(
            "unit",
            "x.test.ts",
            source_file_name="whatever/src/domain/x.ts",
            module="Domain",
            package_prefix="my-custom-pkg",
        )
        self.assertEqual(path, "my-custom-pkg/AItest/UnitTest/Domain/x.test.ts")
        # Explicit empty only for true single-root packages
        path_root = under_generated_test_folder(
            "unit",
            "x.test.ts",
            source_file_name="src/domain/x.ts",
            module="Domain",
            package_prefix="",
        )
        self.assertEqual(path_root, "AItest/UnitTest/Domain/x.test.ts")

    def test_business_folder_named_backend_is_kept(self):
        """Do not treat 'backend' as always-tech when it is a business module under src."""
        self.assertEqual(
            module_rel_from_source("src/backend/services/pay.ts"),
            "backend/services",
        )
        path = under_generated_test_folder(
            "unit",
            "pay.test.ts",
            source_file_name="src/backend/services/pay.ts",
            module="backend",
        )
        self.assertEqual(path, "AItest/UnitTest/backend/pay.test.ts")

    def test_relative_import_from_package_aitest(self):
        src = "pkg-api/src/orders/orders.service.ts"
        path = under_generated_test_folder(
            "unit",
            "orders.service.test.ts",
            source_file_name=src,
            module="Orders",
        )
        from app.services.test_output_layout import sut_module_specifier

        self.assertEqual(sut_module_specifier(path, src), "src/orders/orders.service")
        fixed = rewrite_sut_imports(
            "import { OrdersService } from '../orders.service';\n"
            "import { OrdersService as T2 } from '../../../src/orders/orders.service';\n",
            test_rel=path,
            source_rel=src,
        )
        self.assertIn("from 'src/orders/orders.service'", fixed)
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
        self.assertEqual(path, "AItest/UnitTest/Đăng-nhập/OrderServiceTests.cs")

    def test_fallback_tc_module(self):
        path = under_generated_test_folder(
            "unit",
            "FooTests.cs",
            module="Order",
        )
        self.assertEqual(path, "AItest/UnitTest/Order/FooTests.cs")

    def test_go_internal_kept_as_business_path(self):
        path = under_generated_test_folder(
            "unit",
            "order_test.go",
            source_file_name="internal/order/order.go",
        )
        self.assertEqual(path, "AItest/UnitTest/internal/order/order_test.go")
        self.assertIn("internal/", path)

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
            "import { X } from '@/orders/orders.service';\n"
            "import { Y } from '../../../src/orders/orders.service';\n"
            "import { Z } from '@nestjs/common';\n"
        )
        fixed = rewrite_sut_imports(
            code,
            test_rel="svc/AItest/UnitTest/T/x.test.ts",
            source_rel="svc/src/orders/orders.service.ts",
        )
        self.assertIn("src/orders/orders.service", fixed)
        self.assertNotIn("@/orders", fixed)
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
            assert_safe_aitest_target_rel("pkg-api/AItest/UnitTest/Orders/x.test.ts"),
            "pkg-api/AItest/UnitTest/Orders/x.test.ts",
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

    def test_env_spa_shell_extension(self):
        """Projects can add SPA shell names without editing code."""
        prev = os.environ.get("AITEST_SPA_SHELLS")
        try:
            os.environ["AITEST_SPA_SHELLS"] = "MyHost"
            self.assertEqual(
                module_rel_from_source("MyHost/src/app/billing/pay.ts"),
                "billing",
            )
            self.assertEqual(
                package_prefix_from_source("acme/MyHost/src/app/billing/pay.ts"),
                "acme/MyHost",
            )
        finally:
            if prev is None:
                os.environ.pop("AITEST_SPA_SHELLS", None)
            else:
                os.environ["AITEST_SPA_SHELLS"] = prev

    def test_sanitize_path_segment_caps_long_titles(self):
        long_tc = (
            "E2E-Validation-Khai-báo-thiết-bị-kỹ-thuật-số-Nhập-IMEI-Số-Serial-"
            "chứa-ký-tự-không-phải-chữ-và-số-Hệ-thống-không-chấp-nhận-dữ-liệu-không-hợp-lệ"
        )
        short = sanitize_path_segment(long_tc)
        self.assertLessEqual(len(short), 48)
        self.assertEqual(short, sanitize_path_segment(long_tc))  # stable
        self.assertIn("-", short)

    def test_shorten_e2e_rel_path_preserves_structure(self):
        long_seg = "E2E-Validation-" + ("x" * 80)
        rel = f"AItest/E2ETest/Tạo-vật-chứng/{long_seg}/specs/foo.spec.ts"
        out = shorten_e2e_rel_path(rel)
        parts = out.split("/")
        self.assertEqual(parts[0], "AItest")
        self.assertEqual(parts[1], "E2ETest")
        self.assertEqual(parts[-2], "specs")
        self.assertEqual(parts[-1], "foo.spec.ts")
        self.assertLessEqual(len(parts[3]), 48)

    def test_shorten_e2e_rel_path_keeps_spec_and_page_suffix(self):
        long_spec = (
            "them-tai-lieu-lien-quan-thong-tin-giay-to-khoang-trang-khong-chap-nhan.spec.ts"
        )
        long_page = (
            "them-tai-lieu-lien-quan-thong-tin-giay-to-khoang-trang-khong-chap-nhan.page.ts"
        )
        spec_rel = f"AItest/E2ETest/Mod/specs/{long_spec}"
        page_rel = f"AItest/E2ETest/Mod/pages/{long_page}"
        out_spec = shorten_e2e_rel_path(spec_rel)
        out_page = shorten_e2e_rel_path(page_rel)
        self.assertTrue(out_spec.endswith(".spec.ts"), out_spec)
        self.assertTrue(out_page.endswith(".page.ts"), out_page)
        self.assertNotEqual(out_spec.rsplit("/", 1)[-1], long_spec)
        self.assertNotEqual(out_page.rsplit("/", 1)[-1], long_page)


if __name__ == "__main__":
    unittest.main()
