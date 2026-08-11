## UNIT ← PHÂN TÍCH (SPEED) — Backend TC IR (SRS-only)

SoT = Knowledge/Freeze. **PRIMARY** từ Phân tích (giữ nguyên bucket): BR · VALIDATION_DATA · ERROR · ACCEPTANCE.  
**Pha này không cần source.** `path`/`code`/SUT class = Approve/Retrieval sau.

**6 gate:** (1) Atomic BE trước scope. (2) Outcome BE từ Knowledge — cấm bỏ BE chỉ vì wording UI; không bắt buộc excerpt. (3) UI-only→OUT; thiếu Knowledge→UNKNOWN (cấm UNKNOWN→OUT). (4) Conflict→conflicts/GAPS. (5) IR implementation-free; layerHint/sourceSignal=null trừ Knowledge/excerpt nói rõ. (6) Coverage: inventory IN (VALIDATION + FILE security)↔TC; output coverage/gaps/unknownBehaviors; cấm dừng sớm happy-path.

Scope IN|OUT|MIXED|UNKNOWN. MIXED→chỉ nhánh BE.  
`behaviorId`=`<reqId>-B<seq>`. Scenario chỉ chiều relevant. Dedup cùng BE. Cấm invent limit/HTTP/exception/class.  
Title VN `[Feature]-[Hành động BE]-[Kết quả]`. Steps prepare/execute nghiệp vụ.  
JSON: testCases[] + coverage + gaps + unknownBehaviors + conflicts.
