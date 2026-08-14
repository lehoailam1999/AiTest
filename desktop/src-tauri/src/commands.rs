use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanModule {
    pub name: String,
    pub path: String,
    pub language: Option<String>,
    pub frameworks: Vec<String>,
    pub stacks: Vec<String>,
    pub markers: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScan {
    pub project_path: String,
    pub name: String,
    pub solution_files: Vec<String>,
    pub csproj_files: Vec<String>,
    pub test_projects: Vec<String>,
    pub dotnet_version: Option<String>,
    /// Detected language from project files (e.g. C#).
    pub language: Option<String>,
    /// Target frameworks from .csproj (e.g. net8.0).
    pub frameworks: Vec<String>,
    /// Test frameworks (xUnit, NUnit, MSTest, …).
    pub test_frameworks: Vec<String>,
    /// Tech stacks inferred from SDK / PackageReference.
    pub stacks: Vec<String>,
    /// Top-level folders with detected stack (backend, frontend, …).
    pub modules: Vec<ScanModule>,
    pub warning: Option<String>,
    pub tree: Vec<TreeNode>,
}

const MAX_TREE_NODES: usize = 400;
const MAX_TREE_DEPTH: usize = 4;

#[tauri::command]
pub fn pick_project_folder() -> Option<String> {
    tauri::api::dialog::blocking::FileDialogBuilder::new()
        .set_title("Open Project")
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn pick_executable_file() -> Option<String> {
    tauri::api::dialog::blocking::FileDialogBuilder::new()
        .set_title("Select AI CLI executable")
        .add_filter("Executable", &["exe", "cmd", "bat", "ps1"])
        .add_filter("All files", &["*"])
        .pick_file()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn scan_project(project_path: String) -> Result<ProjectScan, String> {
    let root = PathBuf::from(project_path.trim());
    if !root.is_dir() {
        return Err("Project path is not a directory".into());
    }

    let name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string();

    let solution_files = find_files(&root, ".sln", 6);
    let csproj_files = find_files(&root, ".csproj", 6);
    let test_projects: Vec<String> = csproj_files
        .iter()
        .filter(|p| {
            let lower = p.to_lowercase();
            lower.contains("test") || lower.contains(".tests.")
        })
        .cloned()
        .collect();

    let modules = detect_top_modules(&root);
    let detected = analyze_csproj_files(&csproj_files);
    let (language, frameworks, stacks) = merge_detected(&detected, &modules);
    let mut test_frameworks = detected.test_frameworks;
    for m in &modules {
        collect_test_frameworks_from_module(m, &mut test_frameworks);
    }
    test_frameworks.sort();
    test_frameworks.dedup();

    let has_stack = language.is_some()
        || !frameworks.is_empty()
        || !stacks.is_empty()
        || modules.iter().any(|m| m.language.is_some() || !m.stacks.is_empty());

    let mut warning = None;
    if !has_stack {
        warning = Some(
            "Không nhận diện được stack rõ ràng — vẫn hiển thị cây thư mục. Bạn có thể đồng bộ metadata thủ công."
                .into(),
        );
    }

    let mut counter = 0usize;
    let tree = build_tree(&root, &root, 0, &mut counter);

    Ok(ProjectScan {
        project_path: root.to_string_lossy().into_owned(),
        name,
        solution_files,
        csproj_files,
        test_projects,
        dotnet_version: detect_dotnet_version(),
        language,
        frameworks,
        test_frameworks,
        stacks,
        modules,
        warning,
        tree,
    })
}

fn collect_test_frameworks_from_module(m: &ScanModule, out: &mut Vec<String>) {
    for s in &m.stacks {
        let lower = s.to_lowercase();
        if lower.contains("jest") {
            out.push("Jest".into());
        }
        if lower.contains("vitest") {
            out.push("Vitest".into());
        }
        if lower.contains("mocha") {
            out.push("Mocha".into());
        }
        if lower.contains("pytest") {
            out.push("pytest".into());
        }
        if lower.contains("junit") {
            out.push("JUnit".into());
        }
    }
    for marker in &m.markers {
        let lower = marker.to_lowercase();
        if lower.contains("package.json") {
            // filled from package content in analyze_folder stacks when present
        }
    }
}

fn detect_dotnet_version() -> Option<String> {
    let output = Command::new("dotnet").arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

fn merge_detected(
    csproj: &DetectedStack,
    modules: &[ScanModule],
) -> (Option<String>, Vec<String>, Vec<String>) {
    let mut languages = BTreeSet::new();
    let mut frameworks = BTreeSet::new();
    let mut stacks = BTreeSet::new();

    if let Some(lang) = &csproj.language {
        languages.insert(lang.clone());
    }
    for f in &csproj.frameworks {
        frameworks.insert(f.clone());
    }
    for s in &csproj.stacks {
        stacks.insert(s.clone());
    }
    for m in modules {
        if let Some(lang) = &m.language {
            languages.insert(lang.clone());
        }
        for f in &m.frameworks {
            frameworks.insert(f.clone());
        }
        for s in &m.stacks {
            stacks.insert(s.clone());
        }
    }

    let language = if languages.len() == 1 {
        languages.into_iter().next()
    } else if languages.is_empty() {
        None
    } else {
        Some(languages.into_iter().collect::<Vec<_>>().join(" + "))
    };

    (language, frameworks.into_iter().collect(), stacks.into_iter().collect())
}

/// Scan top-level folders (backend, frontend, …) for stack markers.
fn detect_top_modules(root: &Path) -> Vec<ScanModule> {
    let mut modules = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return modules;
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            !name.starts_with('.')
                && !name.eq_ignore_ascii_case("node_modules")
                && !name.eq_ignore_ascii_case("bin")
                && !name.eq_ignore_ascii_case("obj")
                && !name.eq_ignore_ascii_case("dist")
                && !name.eq_ignore_ascii_case("build")
                && !name.eq_ignore_ascii_case(".git")
        })
        .collect();
    dirs.sort();

    for dir in dirs {
        if let Some(m) = analyze_folder(&dir) {
            modules.push(m);
        }
    }

    // If root itself has markers and no child modules, include root as one module.
    if modules.is_empty() {
        if let Some(m) = analyze_folder(root) {
            modules.push(m);
        }
    }
    modules
}

fn analyze_folder(dir: &Path) -> Option<ScanModule> {
    let name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("root")
        .to_string();

    let mut languages = BTreeSet::new();
    let mut frameworks = BTreeSet::new();
    let mut stacks = BTreeSet::new();
    let mut markers = BTreeSet::new();

    let csprojs = find_files(dir, ".csproj", 4);
    if !csprojs.is_empty() {
        markers.insert(".csproj".into());
        let d = analyze_csproj_files(&csprojs);
        if let Some(l) = d.language {
            languages.insert(l);
        }
        for f in d.frameworks {
            frameworks.insert(f);
        }
        for s in d.stacks {
            stacks.insert(s);
        }
    }
    if !find_files(dir, ".sln", 3).is_empty() {
        markers.insert(".sln".into());
    }

    if let Some(pkg) = find_named_file(dir, "package.json", 3) {
        markers.insert("package.json".into());
        languages.insert("JavaScript/TypeScript".into());
        stacks.insert("Node.js".into());
        if let Ok(content) = fs::read_to_string(&pkg) {
            let lower = content.to_lowercase();
            if lower.contains("\"typescript\"") || find_named_file(dir, "tsconfig.json", 3).is_some() {
                languages.insert("TypeScript".into());
                languages.remove("JavaScript/TypeScript");
            }
            if lower.contains("\"react\"") {
                stacks.insert("React".into());
            }
            if lower.contains("\"vue\"") {
                stacks.insert("Vue".into());
            }
            if lower.contains("\"next\"") {
                stacks.insert("Next.js".into());
            }
            if lower.contains("\"express\"") {
                stacks.insert("Express".into());
            }
            if lower.contains("\"@nestjs/core\"") || lower.contains("\"@nestjs/common\"") {
                stacks.insert("NestJS".into());
            }
            if lower.contains("\"vite\"") {
                stacks.insert("Vite".into());
            }
            if lower.contains("\"angular\"") || lower.contains("\"@angular/core\"") {
                stacks.insert("Angular".into());
            }
            if lower.contains("\"jest\"") {
                stacks.insert("Jest".into());
            }
            if lower.contains("\"vitest\"") {
                stacks.insert("Vitest".into());
            }
            if lower.contains("\"mocha\"") {
                stacks.insert("Mocha".into());
            }
            if lower.contains("\"@playwright/test\"") {
                stacks.insert("Playwright".into());
            }
        }
    }

    if find_named_file(dir, "pyproject.toml", 3).is_some()
        || find_named_file(dir, "requirements.txt", 3).is_some()
        || find_named_file(dir, "Pipfile", 3).is_some()
    {
        if find_named_file(dir, "pyproject.toml", 3).is_some() {
            markers.insert("pyproject.toml".into());
        }
        if find_named_file(dir, "requirements.txt", 3).is_some() {
            markers.insert("requirements.txt".into());
        }
        languages.insert("Python".into());
        if find_named_file(dir, "manage.py", 3).is_some() {
            stacks.insert("Django".into());
        }
        // FastAPI / Flask via requirements content
        if let Some(req) = find_named_file(dir, "requirements.txt", 3)
            .or_else(|| find_named_file(dir, "pyproject.toml", 3))
        {
            if let Ok(content) = fs::read_to_string(&req) {
                let lower = content.to_lowercase();
                if lower.contains("fastapi") {
                    stacks.insert("FastAPI".into());
                }
                if lower.contains("flask") {
                    stacks.insert("Flask".into());
                }
                if lower.contains("django") {
                    stacks.insert("Django".into());
                }
                if lower.contains("pytest") {
                    stacks.insert("pytest".into());
                }
            }
        }
    }

    if find_named_file(dir, "go.mod", 3).is_some() {
        markers.insert("go.mod".into());
        languages.insert("Go".into());
    }
    if find_named_file(dir, "Cargo.toml", 3).is_some() {
        markers.insert("Cargo.toml".into());
        languages.insert("Rust".into());
    }
    if find_named_file(dir, "pom.xml", 3).is_some() {
        markers.insert("pom.xml".into());
        languages.insert("Java".into());
        stacks.insert("Maven".into());
    }
    if find_named_file(dir, "build.gradle", 3).is_some()
        || find_named_file(dir, "build.gradle.kts", 3).is_some()
    {
        markers.insert("Gradle".into());
        languages.insert("Java/Kotlin".into());
        stacks.insert("Gradle".into());
    }

    if markers.is_empty() && languages.is_empty() {
        // Still list the folder so UI reflects structure; mark as unknown.
        return Some(ScanModule {
            name,
            path: dir.to_string_lossy().into_owned(),
            language: None,
            frameworks: Vec::new(),
            stacks: Vec::new(),
            markers: Vec::new(),
        });
    }

    let language = if languages.len() == 1 {
        languages.into_iter().next()
    } else if languages.is_empty() {
        None
    } else {
        Some(languages.into_iter().collect::<Vec<_>>().join(" + "))
    };

    Some(ScanModule {
        name,
        path: dir.to_string_lossy().into_owned(),
        language,
        frameworks: frameworks.into_iter().collect(),
        stacks: stacks.into_iter().collect(),
        markers: markers.into_iter().collect(),
    })
}

fn find_named_file(root: &Path, file_name: &str, max_depth: usize) -> Option<PathBuf> {
    let mut out = None;
    find_named_file_rec(root, file_name, 0, max_depth, &mut out);
    out
}

fn find_named_file_rec(
    current: &Path,
    file_name: &str,
    depth: usize,
    max_depth: usize,
    out: &mut Option<PathBuf>,
) {
    if out.is_some() || depth > max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        if out.is_some() {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("node_modules")
            || name.eq_ignore_ascii_case("bin")
            || name.eq_ignore_ascii_case("obj")
            || name.eq_ignore_ascii_case("dist")
        {
            continue;
        }
        if path.is_file() && name.eq_ignore_ascii_case(file_name) {
            *out = Some(path);
            return;
        }
        if path.is_dir() {
            find_named_file_rec(&path, file_name, depth + 1, max_depth, out);
        }
    }
}

struct DetectedStack {
    language: Option<String>,
    frameworks: Vec<String>,
    test_frameworks: Vec<String>,
    stacks: Vec<String>,
}

/// Parse .csproj files for TFM, SDK, PackageReference → language / frameworks / stacks.
fn analyze_csproj_files(csproj_files: &[String]) -> DetectedStack {
    let mut frameworks = BTreeSet::new();
    let mut test_frameworks = BTreeSet::new();
    let mut stacks = BTreeSet::new();
    let mut saw_csproj = false;

    for path in csproj_files {
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        saw_csproj = true;
        let lower = content.to_lowercase();

        for tfm in extract_xml_tag_values(&content, "TargetFramework") {
            for part in tfm.split(';') {
                let t = part.trim();
                if !t.is_empty() {
                    frameworks.insert(t.to_string());
                }
            }
        }
        for tfms in extract_xml_tag_values(&content, "TargetFrameworks") {
            for part in tfms.split(';') {
                let t = part.trim();
                if !t.is_empty() {
                    frameworks.insert(t.to_string());
                }
            }
        }

        if lower.contains("microsoft.net.sdk.web") {
            stacks.insert("ASP.NET Core".into());
        }
        if lower.contains("microsoft.net.sdk.blazor") || lower.contains("microsoft.aspnetcore.components.webassembly") {
            stacks.insert("Blazor".into());
        }
        if lower.contains("microsoft.net.sdk.worker") {
            stacks.insert("Worker Service".into());
        }
        if lower.contains("microsoft.net.sdk.razor") {
            stacks.insert("Razor".into());
        }
        if lower.contains("usemaui") || lower.contains("microsoft.maui") {
            stacks.insert(".NET MAUI".into());
        }

        for pkg in extract_package_references(&content) {
            let p = pkg.to_lowercase();
            if p.starts_with("xunit") {
                test_frameworks.insert("xUnit".into());
            } else if p.starts_with("nunit") {
                test_frameworks.insert("NUnit".into());
            } else if p.starts_with("mstest") || p.contains("microsoft.testplatform") {
                test_frameworks.insert("MSTest".into());
            }

            if p.starts_with("microsoft.aspnetcore") {
                stacks.insert("ASP.NET Core".into());
            }
            if p.starts_with("microsoft.entityframeworkcore") {
                stacks.insert("EF Core".into());
            }
            if p.starts_with("microsoft.extensions.hosting") {
                stacks.insert("Generic Host".into());
            }
            if p.starts_with("serilog") {
                stacks.insert("Serilog".into());
            }
            if p.starts_with("swashbuckle") {
                stacks.insert("Swagger".into());
            }
            if p.starts_with("mediatr") {
                stacks.insert("MediatR".into());
            }
            if p.starts_with("automapper") {
                stacks.insert("AutoMapper".into());
            }
            if p.starts_with("newtonsoft.json") {
                stacks.insert("Newtonsoft.Json".into());
            }
            if p.starts_with("grpc.") || p == "grpc.aspnetcore" {
                stacks.insert("gRPC".into());
            }
            if p.starts_with("microsoft.playwright") {
                stacks.insert("Playwright".into());
            }
        }
    }

    DetectedStack {
        language: if saw_csproj { Some("C#".into()) } else { None },
        frameworks: frameworks.into_iter().collect(),
        test_frameworks: test_frameworks.into_iter().collect(),
        stacks: stacks.into_iter().collect(),
    }
}

fn extract_xml_tag_values(content: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let open_lower = open.to_lowercase();
    let close_lower = close.to_lowercase();
    let hay = content.to_lowercase();
    let mut out = Vec::new();
    let mut search_from = 0usize;
    while let Some(rel) = hay[search_from..].find(&open_lower) {
        let start = search_from + rel + open_lower.len();
        let Some(rel_end) = hay[start..].find(&close_lower) else {
            break;
        };
        let end = start + rel_end;
        let value = content[start..end].trim().to_string();
        if !value.is_empty() {
            out.push(value);
        }
        search_from = end + close_lower.len();
    }
    out
}

fn extract_package_references(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = content.to_lowercase();
    let mut search_from = 0usize;
    while let Some(rel) = lower[search_from..].find("packagereference") {
        let abs = search_from + rel;
        let tag_start = content[..abs].rfind('<').unwrap_or(abs);
        let rest = &content[tag_start..];
        let tag_end = rest.find('>').map(|i| tag_start + i + 1).unwrap_or(content.len());
        let tag = &content[tag_start..tag_end];
        if let Some(include) = attr_value_ci(tag, "Include") {
            out.push(include);
        }
        search_from = tag_end;
    }
    out
}

fn attr_value_ci(tag: &str, name: &str) -> Option<String> {
    let tag_l = tag.to_lowercase();
    let pattern = format!("{}=\"", name.to_lowercase());
    let idx = tag_l.find(&pattern)?;
    let start = idx + pattern.len();
    let end = tag_l[start..].find('"')? + start;
    let v = tag[start..end].trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

fn find_files(root: &Path, ext: &str, max_depth: usize) -> Vec<String> {
    let mut out = Vec::new();
    collect_files(root, root, ext, 0, max_depth, &mut out);
    out.sort();
    out
}

fn collect_files(
    root: &Path,
    current: &Path,
    ext: &str,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<String>,
) {
    if depth > max_depth {
        return;
    }
    let entries = match fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden + tool caches (pytest/mypy/venv) so they never enter unit-gen context.
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("node_modules")
            || name.eq_ignore_ascii_case("bin")
            || name.eq_ignore_ascii_case("obj")
            || name.eq_ignore_ascii_case("__pycache__")
            || name.eq_ignore_ascii_case("venv")
            || name.eq_ignore_ascii_case(".venv")
        {
            continue;
        }
        if path.is_file() {
            if name.to_lowercase().ends_with(ext) {
                out.push(path.to_string_lossy().into_owned());
            }
        } else if path.is_dir() {
            collect_files(root, &path, ext, depth + 1, max_depth, out);
        }
    }
}

fn is_interesting_source_file(name: &str) -> bool {
    let lower = name.to_lowercase();
    const EXTS: &[&str] = &[
        ".cs", ".sln", ".csproj", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs",
        ".java", ".kt", ".json", ".toml", ".yml", ".yaml",
    ];
    if EXTS.iter().any(|e| lower.ends_with(e)) {
        return true;
    }
    const NAMES: &[&str] = &[
        "package.json",
        "tsconfig.json",
        "go.mod",
        "cargo.toml",
        "pyproject.toml",
        "requirements.txt",
        "pipfile",
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "dockerfile",
    ];
    NAMES.iter().any(|n| lower == *n)
}

fn build_tree(root: &Path, current: &Path, depth: usize, counter: &mut usize) -> Vec<TreeNode> {
    if depth > MAX_TREE_DEPTH || *counter >= MAX_TREE_NODES {
        return Vec::new();
    }

    let entries = match fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let mut nodes: Vec<(bool, TreeNode)> = Vec::new();
    for entry in entries.flatten() {
        if *counter >= MAX_TREE_NODES {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip hidden + tool caches (pytest/mypy/venv) so they never enter unit-gen context.
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("node_modules")
            || name.eq_ignore_ascii_case("bin")
            || name.eq_ignore_ascii_case("obj")
            || name.eq_ignore_ascii_case("__pycache__")
            || name.eq_ignore_ascii_case("venv")
            || name.eq_ignore_ascii_case(".venv")
        {
            continue;
        }
        let is_dir = path.is_dir();
        if !is_dir && !is_interesting_source_file(&name) {
            continue;
        }
        *counter += 1;
        let children = if is_dir {
            build_tree(root, &path, depth + 1, counter)
        } else {
            Vec::new()
        };
        nodes.push((
            is_dir,
            TreeNode {
                name,
                path: path.to_string_lossy().into_owned(),
                is_dir,
                children,
            },
        ));
    }

    nodes.sort_by(|a, b| {
        match (a.0, b.0) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()),
        }
    });
    nodes.into_iter().map(|(_, n)| n).collect()
}

/// List source files by extension.
/// Deprecated for AI generate flow — prefer FastAPI Workspace Manager (`/api/workspace/...`).
#[tauri::command]
pub fn list_source_files(
    project_root: String,
    extensions: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let root = PathBuf::from(project_root.trim());
    if !root.is_dir() {
        return Err("Project path is not a directory".into());
    }
    let exts: Vec<String> = extensions
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            [
                ".cs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt",
            ]
            .iter()
            .map(|s| (*s).to_string())
            .collect()
        });
    let mut out: Vec<String> = Vec::new();
    for ext in &exts {
        let e = if ext.starts_with('.') {
            ext.clone()
        } else {
            format!(".{ext}")
        };
        // Forensic/JHipster: …/ClientApp/src/app/admin/<mod>/list/*.ts is depth ~9–12.
        // Depth 8 silently dropped those files → Code Index / FE resolve mapped wrong
        // shallow components (e.g. activate) → empty locator contract.
        out.extend(find_files(&root, &e, 20));
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Legacy alias — prefer `list_source_files`.
#[tauri::command]
pub fn list_cs_files(project_root: String) -> Result<Vec<String>, String> {
    list_source_files(project_root, Some(vec![".cs".into()]))
}

/// Read ~/.aitest/ide-bridge.json written by IDE plugin (P1 discovery).
#[tauri::command]
pub fn read_ide_bridge_discovery() -> Result<Option<String>, String> {
    let home = dirs_next_home().ok_or_else(|| "Không xác định được home directory".to_string())?;
    let path = home.join(".aitest").join("ide-bridge.json");
    if !path.is_file() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Đọc ide-bridge.json thất bại: {e}"))?;
    Ok(Some(content))
}

fn dirs_next_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Read UTF-8 text under project root.
/// Deprecated for AI generate context — prefer FastAPI `POST /api/workspace/{id}/read`.
#[tauri::command]
pub fn read_text_file(project_root: String, file_path: String) -> Result<String, String> {
    let path = resolve_under_root(&project_root, &file_path, false)?;
    if !path.is_file() {
        return Err("File không tồn tại".into());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Đọc file thất bại: {e}"))?;
    const MAX: usize = 200_000;
    if content.len() > MAX {
        return Ok(content.chars().take(MAX).collect::<String>() + "\n/* …truncated… */");
    }
    Ok(content)
}

#[tauri::command]
pub fn write_text_file(
    project_root: String,
    relative_path: String,
    content: String,
) -> Result<String, String> {
    let rel = relative_path.trim().replace('\\', "/");
    if rel.is_empty() || Path::new(&rel).is_absolute() {
        return Err("Hãy dùng đường dẫn tương đối trong project (vd. tests/FooTests.py)".into());
    }
    if rel.split('/').any(|s| s == "..") {
        return Err("Đường dẫn không được chứa ..".into());
    }
    let path = resolve_under_root(&project_root, &rel, true)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Tạo thư mục thất bại: {e}"))?;
    }
    fs::write(&path, content.as_bytes()).map_err(|e| format!("Ghi file thất bại: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn delete_text_file(project_root: String, relative_path: String) -> Result<(), String> {
    let rel = relative_path.trim().replace('\\', "/");
    if rel.is_empty() || Path::new(&rel).is_absolute() {
        return Err("Hãy dùng đường dẫn tương đối trong project".into());
    }
    if rel.split('/').any(|s| s == "..") {
        return Err("Đường dẫn không được chứa ..".into());
    }
    let path = resolve_under_root(&project_root, &rel, false)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("Xóa file thất bại: {e}"))?;
    }
    Ok(())
}

/// Remove a directory tree under project root. Restricted to `*/.ai-test/**` staging paths.
/// When `empty_only` is true, only remove if the directory is empty (or missing).
#[tauri::command]
pub fn delete_dir(
    project_root: String,
    relative_path: String,
    empty_only: Option<bool>,
) -> Result<(), String> {
    let rel = relative_path
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();
    if rel.is_empty() || Path::new(&rel).is_absolute() {
        return Err("Hãy dùng đường dẫn tương đối trong project".into());
    }
    if rel.split('/').any(|s| s == "..") {
        return Err("Đường dẫn không được chứa ..".into());
    }
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let allowed = parts.iter().any(|s| s.eq_ignore_ascii_case(".ai-test"));
    if !allowed {
        return Err("Chỉ được xóa thư mục dưới .ai-test/ (staging)".into());
    }
    let path = resolve_under_root(&project_root, &rel, true)?;
    if !path.exists() {
        return Ok(());
    }
    if path.is_file() {
        if empty_only.unwrap_or(false) {
            return Ok(());
        }
        fs::remove_file(&path).map_err(|e| format!("Xóa file thất bại: {e}"))?;
        return Ok(());
    }
    if !path.is_dir() {
        return Ok(());
    }
    if empty_only.unwrap_or(false) {
        fs::remove_dir(&path).map_err(|e| format!("Thư mục chưa trống: {e}"))?;
        return Ok(());
    }
    fs::remove_dir_all(&path).map_err(|e| format!("Xóa thư mục thất bại: {e}"))?;
    Ok(())
}

fn resolve_under_root(project_root: &str, file_path: &str, allow_missing: bool) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_root.trim())
        .canonicalize()
        .map_err(|e| format!("Project root không hợp lệ: {e}"))?;

    let joined = if Path::new(file_path.trim()).is_absolute() {
        PathBuf::from(file_path.trim())
    } else {
        root.join(file_path.trim())
    };

    let path = if allow_missing && !joined.exists() {
        normalize_path(&joined)
    } else {
        joined
            .canonicalize()
            .map_err(|e| format!("Đường dẫn không hợp lệ: {e}"))?
    };

    if !is_under_root(&root, &path) {
        return Err("File phải nằm trong ProjectPath (sandbox)".into());
    }
    Ok(path)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn is_under_root(root: &Path, path: &Path) -> bool {
    let root_s = strip_verbatim(root).to_lowercase();
    let path_s = strip_verbatim(path).to_lowercase();
    path_s == root_s || path_s.starts_with(&(root_s + std::path::MAIN_SEPARATOR_STR))
}

/// Windows `canonicalize()` yields `\\?\C:\…` / `\\?\UNC\…`. MSBuild percent-encodes `?`
/// (`\\%3f\…`) and then fails MSB4019 on `$(MSBuildProjectExtensionsPath)*.props`.
/// Strip before any path handed to `dotnet` / `cmd` / shells.
fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy();
    strip_verbatim_str(&s)
}

fn strip_verbatim_str(s: &str) -> String {
    let t = s.trim();
    // \\?\UNC\server\share → \\server\share
    if let Some(rest) = t.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = t.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    // Forward-slash variants (rare)
    if let Some(rest) = t.strip_prefix("//?/UNC/") {
        return format!(r"\\{}", rest.replace('/', "\\"));
    }
    if let Some(rest) = t.strip_prefix("//?/") {
        return rest.replace('/', "\\");
    }
    t.to_string()
}

fn path_for_external_tool(p: &Path) -> PathBuf {
    PathBuf::from(strip_verbatim(p))
}

#[cfg(test)]
mod verbatim_path_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn strips_extended_length_prefix() {
        assert_eq!(
            strip_verbatim_str(r"\\?\D:\Xlab\Forensic\forensic"),
            r"D:\Xlab\Forensic\forensic"
        );
        assert_eq!(
            strip_verbatim_str(r"\\?\UNC\server\share\repo"),
            r"\\server\share\repo"
        );
        assert_eq!(
            path_for_external_tool(Path::new(r"\\?\D:\proj\AItest\AItest.UnitTests.csproj"))
                .to_string_lossy(),
            r"D:\proj\AItest\AItest.UnitTests.csproj"
        );
    }

    #[test]
    fn leaves_normal_paths() {
        assert_eq!(strip_verbatim_str(r"D:\proj"), r"D:\proj");
        assert_eq!(strip_verbatim_str("/home/u/proj"), "/home/u/proj");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    pub exit_code: i32,
    pub success: bool,
    pub passed: i32,
    pub failed: i32,
    pub skipped: i32,
    pub total: i32,
    pub duration_ms: u64,
    pub log: String,
    pub trx_path: Option<String>,
    pub trx_file_name: Option<String>,
    pub command: String,
    pub filter: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

/// Chạy `dotnet test` trong ProjectPath; thu log + parse counters / TRX.
#[tauri::command]
pub fn run_dotnet_test(
    project_root: String,
    filter: Option<String>,
) -> Result<TestRunResult, String> {
    let root = PathBuf::from(project_root.trim())
        .canonicalize()
        .map_err(|e| format!("Project root không hợp lệ: {e}"))?;

    let filter_rel = filter
        .as_ref()
        .map(|s| s.trim().replace('\\', "/"))
        .filter(|s| !s.is_empty());

    let target_arg = if let Some(ref rel) = filter_rel {
        if rel.contains("..") {
            return Err("Filter không được chứa ..".into());
        }
        let p = resolve_under_root(&root.to_string_lossy(), rel, false)?;
        if !p.is_file() {
            return Err(format!("Filter không tồn tại: {rel}"));
        }
        // Absolute path for display/args must NOT keep \\?\ (MSBuild MSB4019).
        Some(strip_verbatim(&p))
    } else {
        None
    };

    let cwd = path_for_external_tool(&root);
    let results_dir = cwd.join("TestResults");
    let _ = fs::create_dir_all(&results_dir);
    let trx_name = format!(
        "aitest-{}.trx",
        chrono_like_stamp()
    );

    let mut args: Vec<String> = Vec::new();
    if let Some(ref t) = target_arg {
        args.push(t.clone());
    }
    args.push("--logger".into());
    args.push(format!("trx;LogFileName={trx_name}"));
    args.push("--results-directory".into());
    args.push(strip_verbatim(&results_dir));
    args.push("--nologo".into());

    let command_display = if target_arg.is_some() {
        format!("dotnet test {} --logger trx …", filter_rel.as_deref().unwrap_or(""))
    } else {
        "dotnet test --logger trx …".into()
    };

    let started = Instant::now();
    let started_at = iso_now();

    let mut cmd = Command::new("dotnet");
    cmd.arg("test")
        .args(&args)
        .current_dir(&cwd);

    let output = cmd
        .output()
        .map_err(|e| format!("Không chạy được `dotnet test`: {e}. Kiểm tra .NET SDK."))?;

    let duration_ms = started.elapsed().as_millis() as u64;
    let finished_at = iso_now();
    let exit_code = output.status.code().unwrap_or(-1);

    let mut log = String::new();
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    const MAX_LOG: usize = 200_000;
    if log.len() > MAX_LOG {
        log = log.chars().take(MAX_LOG).collect::<String>() + "\n…[truncated]";
    }

    let trx_path = find_trx(&results_dir, &trx_name);
    let mut passed = 0i32;
    let mut failed = 0i32;
    let mut skipped = 0i32;
    let mut total = 0i32;

    if let Some(ref tp) = trx_path {
        if let Ok(xml) = fs::read_to_string(tp) {
            if let Some((t, p, f, s)) = parse_trx_counters(&xml) {
                total = t;
                passed = p;
                failed = f;
                skipped = s;
            }
        }
    }
    if total == 0 {
        if let Some((t, p, f, s)) = parse_test_output(&log, "dotnet test") {
            total = t;
            passed = p;
            failed = f;
            skipped = s;
        }
    }

    let success = exit_code == 0 && failed == 0;
    let trx_file_name = trx_path
        .as_ref()
        .map(|p| Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()))
        .flatten();

    Ok(TestRunResult {
        exit_code,
        success,
        passed,
        failed,
        skipped,
        total,
        duration_ms,
        log,
        trx_path,
        trx_file_name,
        command: command_display,
        filter: filter_rel,
        started_at,
        finished_at,
    })
}

/// Chạy lệnh test tuỳ stack (npm test, pytest, go test, …) trong project root.
/// Với npm/jest/vitest: nếu root không có package.json, tự tìm package con (vd. backend/).
#[tauri::command]
pub fn run_test_command(project_root: String, command: String) -> Result<TestRunResult, String> {
    let root = PathBuf::from(project_root.trim())
        .canonicalize()
        .map_err(|e| format!("Project root không hợp lệ: {e}"))?;
    let cmd_line = command.trim();
    if cmd_line.is_empty() {
        return Err("Command test không được để trống".into());
    }

    let cwd_raw = resolve_test_cwd(&root, cmd_line)?;
    // MSBuild/dotnet choke on \\?\ cwd (MSB4019). Node/pytest are fine either way.
    let cwd = path_for_external_tool(&cwd_raw);
    let root_ext = path_for_external_tool(&root);
    let started = Instant::now();
    let started_at = iso_now();

    // Windows: Rust's default arg quoting breaks nested quotes around paths with spaces
    // (e.g. pytest "AItest/UnitTest/To do/x.py" → pytest sees "AItest/UnitTest/To).
    // raw_arg passes the /C payload exactly as typed.
    #[cfg(windows)]
    let output = {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .raw_arg("/C")
            .raw_arg(cmd_line)
            .current_dir(&cwd)
            .output()
            .map_err(|e| format!("Không chạy được lệnh test: {e}"))?
    };

    #[cfg(not(windows))]
    let output = Command::new("sh")
        .args(["-c", cmd_line])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Không chạy được lệnh test: {e}"))?;

    let duration_ms = started.elapsed().as_millis() as u64;
    let finished_at = iso_now();
    let exit_code = output.status.code().unwrap_or(-1);

    let mut log = String::new();
    if cwd != root_ext {
        log.push_str(&format!(
            "[AITest] cwd = {}\n",
            cwd.to_string_lossy()
        ));
    }
    log.push_str(&String::from_utf8_lossy(&output.stdout));
    if !output.stderr.is_empty() {
        if !log.is_empty() {
            log.push('\n');
        }
        log.push_str(&String::from_utf8_lossy(&output.stderr));
    }

    // Friendlier hint when npm cannot find package.json
    if exit_code != 0
        && log.to_lowercase().contains("enoent")
        && log.to_lowercase().contains("package.json")
    {
        log.push_str(
            "\n[AITest] Gợi ý: gắn Root Apply vào thư mục có package.json (vd. backend/), \
hoặc mở monorepo có package.json ở package Nest/Jest.",
        );
    }

    let mut passed = 0i32;
    let mut failed = 0i32;
    let mut skipped = 0i32;
    let mut total = 0i32;
    if let Some((t, p, f, s)) = parse_test_output(&log, cmd_line) {
        total = t;
        passed = p;
        failed = f;
        skipped = s;
    }

    let success = exit_code == 0 && failed == 0;
    Ok(TestRunResult {
        exit_code,
        success,
        passed,
        failed,
        skipped,
        total,
        duration_ms,
        log,
        trx_path: None,
        trx_file_name: None,
        command: cmd_line.to_string(),
        filter: None,
        started_at,
        finished_at,
    })
}

fn is_node_test_command(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    c.contains("npm")
        || c.contains("pnpm")
        || c.contains("yarn")
        || c.contains("npx")
        || c.contains("jest")
        || c.contains("vitest")
}

/// Pick cwd for test command: root if it has the right marker, else best nested package.
/// When the command uses npm/pnpm/yarn workspace filters, keep repo root (filters need it).
/// When ``--config …/AItest/jest.config.cjs``, cwd = package that owns AItest (node_modules).
fn resolve_test_cwd(root: &Path, cmd: &str) -> Result<PathBuf, String> {
    if !is_node_test_command(cmd) {
        return Ok(root.to_path_buf());
    }
    // Workspace filters must run from the workspace root, not a nested package cwd.
    if uses_node_workspace_filter(cmd) {
        return Ok(root.to_path_buf());
    }
    if let Some(pkg) = package_cwd_from_aitest_jest_config(root, cmd) {
        return Ok(pkg);
    }
    if root.join("package.json").is_file() {
        // Prefer nested package that owns AItest when present (Nest monorepo-ish folders).
        if let Some(pkg) = find_aitest_package_cwd(root) {
            return Ok(pkg);
        }
        return Ok(root.to_path_buf());
    }
    let mut pkgs: Vec<PathBuf> = Vec::new();
    collect_named_files(root, "package.json", 0, 4, &mut pkgs);
    if pkgs.is_empty() {
        return Err(format!(
            "Không tìm thấy package.json dưới {}. \
Gắn Root Apply vào folder có package.json (vd. D:\\TestIDE\\backend) rồi chạy lại.",
            root.display()
        ));
    }
    // Prefer Nest/Jest/Vitest package over plain frontend SPA when multiple exist.
    let mut best: Option<(i32, PathBuf)> = None;
    for pkg in pkgs {
        let parent = pkg.parent().unwrap_or(root).to_path_buf();
        let score = score_node_package(&pkg);
        if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, parent));
        }
    }
    Ok(best.map(|(_, p)| p).unwrap_or_else(|| root.to_path_buf()))
}

fn package_cwd_from_aitest_jest_config(root: &Path, cmd: &str) -> Option<PathBuf> {
    let cfg = extract_jest_config_arg(cmd)?;
    let cfg_path = if Path::new(&cfg).is_absolute() {
        PathBuf::from(&cfg)
    } else {
        root.join(&cfg)
    };
    let aitest_dir = cfg_path.parent()?;
    let name = aitest_dir.file_name()?.to_string_lossy();
    if !name.eq_ignore_ascii_case("aitest") {
        return None;
    }
    let pkg = aitest_dir.parent()?.to_path_buf();
    if pkg.join("package.json").is_file() {
        Some(pkg)
    } else {
        None
    }
}

fn find_aitest_package_cwd(root: &Path) -> Option<PathBuf> {
    let direct = root.join("AItest").join("jest.config.cjs");
    if direct.is_file() && root.join("package.json").is_file() {
        return Some(root.to_path_buf());
    }
    let mut pkgs: Vec<PathBuf> = Vec::new();
    collect_named_files(root, "package.json", 0, 4, &mut pkgs);
    let mut best: Option<(i32, PathBuf)> = None;
    for pkg_json in pkgs {
        let parent = pkg_json.parent()?.to_path_buf();
        if !parent.join("AItest").join("jest.config.cjs").is_file()
            && !parent.join("AItest").is_dir()
        {
            continue;
        }
        let score = score_node_package(&pkg_json) + 100;
        if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
            best = Some((score, parent));
        }
    }
    best.map(|(_, p)| p)
}

fn extract_jest_config_arg(cmd: &str) -> Option<String> {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    for (i, t) in tokens.iter().enumerate() {
        if *t == "--config" || *t == "-c" {
            let next = tokens.get(i + 1)?;
            return Some(next.trim_matches('"').trim_matches('\'').to_string());
        }
        if let Some(rest) = t.strip_prefix("--config=") {
            return Some(rest.trim_matches('"').trim_matches('\'').to_string());
        }
    }
    None
}

fn uses_node_workspace_filter(cmd: &str) -> bool {
    let c = cmd.to_lowercase();
    c.contains(" --filter")
        || c.contains("\t--filter")
        || c.contains(" -w ")
        || c.contains(" -w=")
        || c.contains("--workspace")
        || c.contains(" yarn workspace ")
        || c.contains("yarn workspace ")
        || c.contains("pnpm --filter")
        || c.contains("npx turbo")
        || c.contains("nx test")
}

fn score_node_package(pkg_path: &Path) -> i32 {
    let Ok(content) = fs::read_to_string(pkg_path) else {
        return 0;
    };
    let lower = content.to_lowercase();
    let mut score = 1;
    if lower.contains("\"jest\"") || lower.contains("\"@jest/core\"") {
        score += 50;
    }
    if lower.contains("\"vitest\"") {
        score += 50;
    }
    if lower.contains("\"@nestjs/core\"") || lower.contains("\"@nestjs/common\"") {
        score += 40;
    }
    if lower.contains("\"test\"") {
        score += 5;
    }
    // Prefer backend-ish folder names
    if let Some(parent) = pkg_path.parent() {
        let name = parent
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name.contains("backend") || name.contains("api") || name.contains("server") {
            score += 20;
        }
        if name.contains("frontend") || name.contains("web") || name == "app" {
            score -= 10;
        }
    }
    score
}

fn collect_named_files(
    current: &Path,
    file_name: &str,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<PathBuf>,
) {
    if depth > max_depth {
        return;
    }
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')
            || name.eq_ignore_ascii_case("node_modules")
            || name.eq_ignore_ascii_case("bin")
            || name.eq_ignore_ascii_case("obj")
            || name.eq_ignore_ascii_case("dist")
            || name.eq_ignore_ascii_case("build")
            || name.eq_ignore_ascii_case("coverage")
            || name.eq_ignore_ascii_case(".git")
        {
            continue;
        }
        if path.is_file() && name.eq_ignore_ascii_case(file_name) {
            out.push(path);
        } else if path.is_dir() {
            collect_named_files(&path, file_name, depth + 1, max_depth, out);
        }
    }
}

fn chrono_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn iso_now() -> String {
    // RFC3339-ish UTC without chrono crate
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Enough for FE; Backend also accepts missing and uses server time
    format!("{secs}")
}

fn find_trx(results_dir: &Path, preferred_name: &str) -> Option<String> {
    let preferred = results_dir.join(preferred_name);
    if preferred.is_file() {
        return Some(preferred.to_string_lossy().into_owned());
    }
    // dotnet sometimes nests under guid folders
    let mut latest: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(walk) = fs::read_dir(results_dir) {
        for e in walk.flatten() {
            let p = e.path();
            if p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("trx") {
                let modified = e.metadata().and_then(|m| m.modified()).ok();
                if let Some(m) = modified {
                    if latest.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
                        latest = Some((m, p));
                    }
                }
            } else if p.is_dir() {
                if let Ok(inner) = fs::read_dir(&p) {
                    for ie in inner.flatten() {
                        let ip = ie.path();
                        if ip.is_file() && ip.extension().and_then(|x| x.to_str()) == Some("trx") {
                            let modified = ie.metadata().and_then(|m| m.modified()).ok();
                            if let Some(m) = modified {
                                if latest.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
                                    latest = Some((m, ip));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    latest.map(|(_, p)| p.to_string_lossy().into_owned())
}

fn parse_trx_counters(xml: &str) -> Option<(i32, i32, i32, i32)> {
    // <Counters total="3" executed="3" passed="2" failed="1" ...
    let lower = xml; // keep case — attributes are lowercase in TRX
    let total = attr_i32(lower, "total")?;
    let passed = attr_i32(lower, "passed").unwrap_or(0);
    let failed = attr_i32(lower, "failed").unwrap_or(0);
    let skipped = attr_i32(lower, "notexecuted")
        .or_else(|| attr_i32(lower, "inconclusive"))
        .unwrap_or(0);
    Some((total, passed, failed, skipped))
}

fn attr_i32(xml: &str, name: &str) -> Option<i32> {
    let key = format!("{name}=\"");
    let idx = xml.find(&key)?;
    let rest = &xml[idx + key.len()..];
    let end = rest.find('"')?;
    rest[..end].parse().ok()
}

/// Parse test counters from console output (multi-runner).
fn parse_test_output(log: &str, command: &str) -> Option<(i32, i32, i32, i32)> {
    let cmd = command.to_lowercase();
    let prefer_pytest = cmd.contains("pytest") || cmd.contains("py.test");
    let prefer_js = cmd.contains("npm")
        || cmd.contains("pnpm")
        || cmd.contains("yarn")
        || cmd.contains("jest")
        || cmd.contains("vitest")
        || cmd.contains("npx");
    let prefer_go = cmd.contains("go test");

    let try_all = |log: &str| {
        parse_pytest_summary(log)
            .or_else(|| parse_jest_vitest(log))
            .or_else(|| parse_go_test(log))
            .or_else(|| parse_dotnet_console_counters(log))
    };

    if prefer_pytest {
        if let Some(r) = parse_pytest_summary(log) {
            return Some(r);
        }
    }
    if prefer_js {
        if let Some(r) = parse_jest_vitest(log) {
            return Some(r);
        }
    }
    if prefer_go {
        if let Some(r) = parse_go_test(log) {
            return Some(r);
        }
    }
    try_all(log)
}

fn digits_before(hay: &str, needle: &str) -> Option<i32> {
    let idx = hay.find(needle)?;
    let before = hay[..idx].trim_end();
    let num: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    if num.is_empty() {
        None
    } else {
        num.parse().ok()
    }
}

/// pytest summary: `5 passed, 2 failed, 1 skipped in 0.12s` or `===== 5 passed in 0.12s =====`
fn parse_pytest_summary(log: &str) -> Option<(i32, i32, i32, i32)> {
    let mut fallback: Option<(i32, i32, i32, i32)> = None;
    for line in log.lines().rev().take(80) {
        let l = line.trim();
        if !(l.contains("passed") || l.contains("failed") || l.contains("error")) {
            continue;
        }
        let passed = digits_before(l, " passed").unwrap_or(0);
        let failed = digits_before(l, " failed").unwrap_or(0)
            + digits_before(l, " errors").unwrap_or(0)
            + digits_before(l, " error").unwrap_or(0);
        let skipped = digits_before(l, " skipped").unwrap_or(0)
            + digits_before(l, " deselected").unwrap_or(0);
        if passed + failed + skipped == 0 {
            continue;
        }
        let total = passed + failed + skipped;
        let row = (total, passed, failed, skipped);
        fallback = Some(row);
        if l.contains('=') || l.contains(" in ") {
            return Some(row);
        }
    }
    fallback
}

/// Jest / Vitest / npm test: `Tests: 2 failed, 3 passed, 5 total` or `Tests  3 passed | 2 failed (5)`
fn parse_jest_vitest(log: &str) -> Option<(i32, i32, i32, i32)> {
    for line in log.lines().rev().take(120) {
        let l = line.trim();
        let is_tests_line = l.starts_with("Tests:") || l.starts_with("Tests ") || l.starts_with("Tests\t");
        if !is_tests_line {
            continue;
        }
        let mut passed = digits_before(l, " passed").unwrap_or(0);
        let mut failed = digits_before(l, " failed").unwrap_or(0);
        let skipped = digits_before(l, " skipped").unwrap_or(0);
        let mut total = digits_before(l, " total").unwrap_or(0);
        if l.contains('|') {
            if let Some(v) = digits_before(l, " passed") {
                passed = v;
            }
            if let Some(v) = digits_before(l, " failed") {
                failed = v;
            }
            if let Some(open) = l.rfind('(') {
                if let Some(close) = l[open..].find(')') {
                    let inner = l[open + 1..open + close].trim();
                    if let Ok(t) = inner.parse::<i32>() {
                        total = t;
                    }
                }
            }
        }
        if passed + failed + skipped + total == 0 {
            continue;
        }
        if total == 0 {
            total = passed + failed + skipped;
        }
        return Some((total, passed, failed, skipped));
    }
    None
}

/// go test: count `--- PASS:` / `--- FAIL:` lines.
fn parse_go_test(log: &str) -> Option<(i32, i32, i32, i32)> {
    let mut pass_cases = 0i32;
    let mut fail_cases = 0i32;
    for line in log.lines() {
        let t = line.trim_start();
        if t.starts_with("--- FAIL:") {
            fail_cases += 1;
        } else if t.starts_with("--- PASS:") {
            pass_cases += 1;
        }
    }
    if pass_cases + fail_cases == 0 {
        return None;
    }
    let passed = pass_cases;
    let failed = fail_cases;
    let total = passed + failed;
    Some((total, passed, failed, 0))
}

fn parse_dotnet_console_counters(log: &str) -> Option<(i32, i32, i32, i32)> {
    // "Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, ..."
    let mut passed = 0i32;
    let mut failed = 0i32;
    let mut skipped = 0i32;
    let mut total = 0i32;
    let mut found = false;
    for line in log.lines() {
        let l = line.trim();
        if !(l.contains("Passed:") || l.contains("Failed:")) {
            continue;
        }
        if let Some(v) = console_num(l, "Passed:") {
            passed = v;
            found = true;
        }
        if let Some(v) = console_num(l, "Failed:") {
            failed = v;
            found = true;
        }
        if let Some(v) = console_num(l, "Skipped:") {
            skipped = v;
            found = true;
        }
        if let Some(v) = console_num(l, "Total:") {
            total = v;
            found = true;
        }
    }
    if !found {
        return None;
    }
    if total == 0 {
        total = passed + failed + skipped;
    }
    Some((total, passed, failed, skipped))
}

fn console_num(line: &str, label: &str) -> Option<i32> {
    let idx = line.find(label)?;
    let rest = line[idx + label.len()..].trim_start();
    let num: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if num.is_empty() {
        None
    } else {
        num.parse().ok()
    }
}

#[cfg(test)]
mod test_output_parsers {
    use super::{parse_go_test, parse_jest_vitest, parse_pytest_summary, parse_test_output};

    #[test]
    fn pytest_summary_line() {
        let log = "collected 3 items\n\n===== 2 passed, 1 failed in 0.05s =====";
        let (t, p, f, s) = parse_pytest_summary(log).unwrap();
        assert_eq!((t, p, f, s), (3, 2, 1, 0));
    }

    #[test]
    fn jest_tests_line() {
        let log = "Test Suites: 1 passed, 1 total\nTests:       2 failed, 3 passed, 5 total\n";
        let (t, p, f, s) = parse_jest_vitest(log).unwrap();
        assert_eq!((t, p, f, s), (5, 3, 2, 0));
    }

    #[test]
    fn go_pass_fail_lines() {
        let log = "--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\n";
        let (t, p, f, s) = parse_go_test(log).unwrap();
        assert_eq!((t, p, f, s), (2, 1, 1, 0));
    }

    #[test]
    fn parse_test_output_prefers_pytest_command() {
        let log = "===== 1 passed in 0.01s =====";
        let r = parse_test_output(log, "python -m pytest");
        assert_eq!(r, Some((1, 1, 0, 0)));
    }
}

/// EX4.4 — open file or folder in the OS (Explorer / default app).
#[tauri::command]
pub fn open_path_in_os(path: String) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err(format!("Path không tồn tại: {}", p.display()));
    }
    #[cfg(target_os = "windows")]
    {
        // Prefer reveal file in Explorer; for dirs just open.
        if p.is_file() {
            Command::new("explorer")
                .arg("/select,")
                .arg(&p)
                .spawn()
                .map_err(|e| format!("explorer: {e}"))?;
        } else {
            Command::new("explorer")
                .arg(&p)
                .spawn()
                .map_err(|e| format!("explorer: {e}"))?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("open: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("xdg-open: {e}"))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("open_path_in_os: unsupported OS".into())
}
