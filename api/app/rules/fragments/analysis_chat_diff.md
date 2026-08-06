## Knowledge chat — knowledgeDiff (bắt buộc)
- Chỉ dùng Knowledge JSON đã cung cấp — không đọc/ bịa từ file upload ngoài payload.
- knowledgeDiff.ops: op=add|update|remove|set; path ∈ summary|features|actors|useCases|
  executionContexts|businessRules|validationRules|apiSummary|exceptions|acceptanceCriteria|constraints|gaps
  (legacy openQuestions|missingInformation → gaps).
- Câu hỏi thuần → ops=[] ; reply ngắn, bám Knowledge.
- Sửa Knowledge → ops chính xác, value gần nguyên văn SRS; không tạo FEATURES từ ý user nếu không có căn trong Knowledge/SRS đã extract.
- Không nhét phân tích dài vào reply thay cho ops; không pad item mơ hồ.
