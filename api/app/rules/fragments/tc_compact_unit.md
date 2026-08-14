QUY TẮC CHUNG UNIT (BẮT BUỘC — BACKEND ONLY, PORTABLE, SRS-ONLY):
1. Bám Knowledge PRIMARY ONLY (BR/VALIDATION/ERROR/AC-BE); 6 gate IR; scope IN|OUT|MIXED|UNKNOWN. FEATURES=tên module; FLOWS/UI→không sinh.
2. module = Feature name; title VN `[Feature] - [Hành động BE] - [Kết quả]` — cấm Class.Method / UI verbs.
3. Steps = prepare/execute nghiệp vụ BE. Bắt buộc primaryBucket+behaviorId+(VALIDATION→target.*). path/code = pha Approve.
4. 1 behaviorId / 1 TC; dedup cùng BE; coverage/gaps/unknown; cấm dừng sớm bỏ VALIDATION/FILE.
5. Không gộp Unit+E2E. OUT/presentation-only → không sinh. priority/severity thang Việt.
6. Self-check: còn IN chưa cover → TC hoặc gap; đủ → dừng.
