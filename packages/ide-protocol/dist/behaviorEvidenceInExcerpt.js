/**
 * Layer 3b — TC behavior must be evidenced in SUT excerpt (body-rule path).
 * Portable heuristics; no product nouns.
 */
function extractMarker(blob, key) {
    const re = new RegExp(`^${key.replace(/\./g, "\\.")}\\s*:\\s*(.+)$`, "im");
    return (blob.match(re)?.[1] || "").trim();
}
export function isValidationDataBucket(tcBlob) {
    return (/primaryBucket:\s*VALIDATION_DATA/i.test(tcBlob) ||
        /trace:\s*VALIDATION_DATA/i.test(tcBlob));
}
/**
 * When excerpt is non-empty, require observable constraint signals in source body.
 */
export function behaviorEvidenceInExcerpt(tcBlob, excerpt) {
    const body = String(excerpt || "").trim();
    if (!body)
        return { ok: true };
    const low = body.toLowerCase();
    const constraint = extractMarker(tcBlob, "target.constraint").toLowerCase();
    const field = extractMarker(tcBlob, "target.property") ||
        extractMarker(tcBlob, "target.field");
    const fieldLatin = /^[A-Za-z_][\w]*$/.test(field) ? field : "";
    const fieldLabel = fieldLatin || field || "target field";
    const fieldWindow = (() => {
        if (!fieldLatin)
            return body;
        const at = low.indexOf(fieldLatin.toLowerCase());
        if (at < 0)
            return "";
        return body.slice(Math.max(0, at - 350), Math.min(body.length, at + 350));
    })();
    const escapedField = fieldLatin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fieldHasAttribute = (attributePattern) => {
        if (!fieldLatin)
            return false;
        return new RegExp(`(?:${attributePattern})[^{};]{0,240}\\b${escapedField}\\b`, "i").test(body);
    };
    // Latin-looking TC labels that never appear in SUT are unbound — not feature gaps.
    if (fieldLatin && !body.toLowerCase().includes(fieldLatin.toLowerCase())) {
        return {
            ok: false,
            skipReason: `FAIL_FIELD_UNBOUND — «${fieldLabel}» không có trong source/index`,
        };
    }
    if (isValidationDataBucket(tcBlob)) {
        if (/required|bắt buộc|not\s*empty|không.*trống|mandatory/.test(constraint)) {
            if (fieldLatin) {
                if (fieldHasAttribute("\\[\\s*required\\b|requiredattribute|notempty|notnull|@notnull|@notblank")) {
                    return { ok: true };
                }
                if (body.includes(fieldLatin) &&
                    /IsNullOrWhiteSpace|IsNullOrEmpty|\.Length\s*==\s*0|ArgumentNullException/i.test(body)) {
                    return { ok: true };
                }
                return {
                    ok: false,
                    skipReason: `FAIL_FEATURE_GAP — «${fieldLabel}» không có required trong source`,
                };
            }
            if (/\[required\]|requiredattribute|stringlength|maxlength/i.test(body)) {
                return { ok: true };
            }
            if (/throw|badrequest|validationexception|argumentexception/i.test(low)) {
                return { ok: true };
            }
            return {
                ok: false,
                skipReason: `FAIL_FEATURE_GAP — «${fieldLabel}» không có required trong source`,
            };
        }
        if (/unique|duplicate|trùng/.test(constraint)) {
            if (/duplicate|unique|exists|already|any\s*\(/i.test(low)) {
                return { ok: true };
            }
            return {
                ok: false,
                skipReason: `FAIL_FEATURE_GAP — «${fieldLabel}» không có duplicate/unique behavior trong source`,
            };
        }
        if (/maxlength|max\s*length|\d+\s*ký/.test(constraint)) {
            const maxLengthSignal = /\[\s*maxlength\s*\(|\[\s*stringlength\s*\(|lengthattribute|@size\s*\(|@length\s*\(|maxlength\s*[:=]|\.max\s*\(/i;
            if ((fieldLatin &&
                (fieldHasAttribute("\\[\\s*maxlength\\s*\\(|\\[\\s*stringlength\\s*\\(|lengthattribute|@size\\s*\\(|@length\\s*\\(") ||
                    new RegExp(`\\b${escapedField}\\b[^\\n]{0,180}(?:maximumlength|maxlength|\\.max\\s*\\()`, "i").test(body))) ||
                (!fieldLatin && maxLengthSignal.test(body))) {
                return { ok: true };
            }
            return {
                ok: false,
                skipReason: `FAIL_FEATURE_GAP — «${fieldLabel}» không có MaxLength trong source`,
            };
        }
        if (/throw|badrequest|validate|required|notfound/i.test(low)) {
            return { ok: true };
        }
        return {
            ok: false,
            skipReason: `FAIL_FEATURE_GAP — behavior của «${fieldLabel}» không có trong source`,
        };
    }
    const tcLow = tcBlob.toLowerCase();
    if (/reject|từ chối|duplicate|notfound|accessdenied/i.test(tcLow)) {
        if (/throw|badrequest|notfound|accessdenied|duplicate|exists/i.test(low)) {
            return { ok: true };
        }
        if (/primaryBucket:\s*BUSINESS_RULES/i.test(tcBlob)) {
            return {
                ok: false,
                skipReason: "FAIL_VALIDATE — BR reject/duplicate not in excerpt",
            };
        }
    }
    return { ok: true };
}
