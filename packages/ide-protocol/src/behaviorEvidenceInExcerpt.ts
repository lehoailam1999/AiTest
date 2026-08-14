/**
 * Layer 3b — TC behavior must be evidenced in SUT excerpt (body-rule path).
 * Portable heuristics; no product nouns.
 */

function extractMarker(blob: string, key: string): string {
  const re = new RegExp(
    `^${key.replace(/\./g, "\\.")}\\s*:\\s*(.+)$`,
    "im"
  );
  return (blob.match(re)?.[1] || "").trim();
}

export function isValidationDataBucket(tcBlob: string): boolean {
  return (
    /primaryBucket:\s*VALIDATION_DATA/i.test(tcBlob) ||
    /trace:\s*VALIDATION_DATA/i.test(tcBlob)
  );
}

/**
 * When excerpt is non-empty, require observable constraint signals in source body.
 */
export function behaviorEvidenceInExcerpt(
  tcBlob: string,
  excerpt: string
): { ok: boolean; skipReason?: string } {
  const body = String(excerpt || "").trim();
  if (!body) return { ok: true };

  const low = body.toLowerCase();
  const constraint = extractMarker(tcBlob, "target.constraint").toLowerCase();
  const field =
    extractMarker(tcBlob, "target.property") ||
    extractMarker(tcBlob, "target.field");
  const fieldLatin = /^[A-Za-z_][\w]*$/.test(field) ? field : "";

  if (isValidationDataBucket(tcBlob)) {
    if (/required|bắt buộc|not\s*empty|không.*trống|mandatory/.test(constraint)) {
      if (fieldLatin) {
        if (
          body.includes(fieldLatin) &&
          /\[required\]|requiredattribute|maxlength|stringlength/i.test(body)
        ) {
          return { ok: true };
        }
        if (
          body.includes(fieldLatin) &&
          /IsNullOrWhiteSpace|IsNullOrEmpty|\.Length\s*==\s*0|ArgumentNullException/i.test(
            body
          )
        ) {
          return { ok: true };
        }
        return {
          ok: false,
          skipReason:
            "FAIL_VALIDATE — required constraint for field not evidenced in excerpt",
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
        skipReason:
          "FAIL_VALIDATE — required constraint not evidenced in excerpt",
      };
    }
    if (/unique|duplicate|trùng/.test(constraint)) {
      if (/duplicate|unique|exists|already|any\s*\(/i.test(low)) {
        return { ok: true };
      }
      return {
        ok: false,
        skipReason:
          "FAIL_VALIDATE — duplicate/unique constraint not in excerpt",
      };
    }
    if (/maxlength|max\s*length|\d+\s*ký/.test(constraint)) {
      if (/maxlength|stringlength|\[\s*max/i.test(body)) return { ok: true };
      return {
        ok: false,
        skipReason: "FAIL_VALIDATE — maxLength not evidenced in excerpt",
      };
    }
    if (/throw|badrequest|validate|required|notfound/i.test(low)) {
      return { ok: true };
    }
    return {
      ok: false,
      skipReason: "FAIL_VALIDATE — VALIDATION behavior not evidenced in excerpt",
    };
  }

  const tcLow = tcBlob.toLowerCase();
  if (
    /reject|từ chối|duplicate|notfound|accessdenied|compartmentnotfound/i.test(
      tcLow
    )
  ) {
    if (
      /throw|badrequest|notfound|accessdenied|duplicate|exists|compartmentnotfound/i.test(
        low
      )
    ) {
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
