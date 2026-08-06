# Codegen legacy cleanup (sau Phase 1–4)

> Mục tiêu: giữ **một** pipeline chính Index → Plan → Retrieve → Context → AI CLI;  
> phần cũ chỉ còn **fallback** hoặc **xoá** khi không còn caller.

Cập nhật: 2026-08-05.

---

## Pipeline chính (KEEP — không xoá)

| Module | Vai trò |
|--------|---------|
| `desktop/src/lib/codeIndex/**` | Index source → `.ai-test/index.db` |
| `desktop/src/lib/testPlanner/**` | Plan từ TC (keywords / path / action) |
| `desktop/src/lib/retrieval/**` | Top-K Unit / E2E |
| `desktop/src/lib/contextBuilder/**` | Đọc Top-K + budget → packet |
| `ideLocalCommands.buildGenerateContext` | Unit: index-first → AI CLI |
| `e2eJobRunner` index branch | E2E: index-first |
| `uutgs_rules.py` / `e2e_codegen_rules.py` | SoT rules portable |

---

## Fallback (KEEP tạm — chưa xoá)

| Path | Lý do giữ | Điều kiện xoá sau |
|------|-----------|-------------------|
| `projectIntelligence/contextBuilder.ts` (+ seed/deps) | Khi không có index / Tauri fail | Index bắt buộc + KPI ổn |
| `resolveE2eFeSources.ts` | E2E khi index trống / cold | Index FE coverage đủ |
| `generate_unit` workspace expand (`P4 deprecation`) | Client cũ / không packet | Telemetry = 0 trong 2 sprint |
| `resolveTcSourcePrimary` / `aiScopeResolve` | UI preview + Unit fallback khi index miss | Gen Unit 100% index |
| `deriveFeaturePathFromTc.ts` | Runtime E2E entry path (giàu hơn planner) | Merge vào testPlanner |
| `e2e_journey_rules.py` / grounding pointer | Checklist mỏng, không SoT kép | Giữ slim |

---

## Đã / sẽ REMOVE

| Path | Trạng thái | Ghi chú |
|------|------------|---------|
| `desktop/src/platform/intelligence/index.ts` | **REMOVED** | Barrel không ai import |
| Unit gen **double-rank** (workspace/AI rồi mới index) | **REMOVED** hành vi | Gen đi index-first; legacy rank chỉ khi index không ra primary |
| Comment “skip index khi manualPrimaryPath” | **FIXED** | Index vẫn chạy; manual chỉ promote nếu có trong hits |

---

## Không xoá (dễ nhầm)

| Path | Lý do |
|------|-------|
| `api/app/services/test_planner.py` | Mirror + tests; chưa wire router nhưng giữ sync với TS |
| `desktop/scripts/runCodeIndex.ts` / `runIndexAndRetrieve.ts` | Dev/smoke Forensic |
| `GenerateHubPage` / `buildTcJobContext` | Sinh **TC** từ requirement — khác gen Unit code |
| `agentApi.analyzeIntent` | Agent business intent — **không** phải `testPlanner.analyzeIntent` |

---

## Phương án từng bước

### Bước A (đã làm trong PR cleanup này)
1. Xoá barrel `platform/intelligence` chết.  
2. Unit `runForTestCase`: **index-first**, chỉ gọi `resolveTcSourcePrimary` khi index không cho primary.  
3. Ghi rõ fallback trên `resolveE2eFeSources`.  
4. Document bảng KEEP/FALLBACK/REMOVE này.

### Bước B (sprint sau — đo rồi mới xoá)
1. Metric: % Unit/E2E gen dùng index vs fallback.  
2. Khi fallback &lt; 5%: deprecate UI “AI scope resolve” mặc định off.  
3. Merge `path:` extractors → một util (`extractFeaturePath` + route/url markers).  
4. Hard-fail API nếu thiếu `contextPacket` (bỏ workspace expand).

### Bước C (không làm)
- Không gộp UUTGS + E2ECG thành một file.  
- Không xoá `projectIntelligence` khi E2E fallback còn cần `tcSeedResolver`.  
- Không xoá DOM inspect / POM / heal E2E — đó là Phase 6 runtime, không phải legacy context dump.

---

## Tóm tắt cho bạn

- **Còn dùng:** Index/Planner/Retrieve/Context + AI CLI + rules SoT + fallback khi index thiếu.  
- **Bỏ hành vi trùng:** double-rank Unit trước mỗi gen.  
- **Chưa bỏ file lớn:** `resolveE2eFeSources`, `projectIntelligence`, workspace expand — vẫn là lưới an toàn.  
- **Đã bỏ:** barrel platform intelligence không caller.
