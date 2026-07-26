import DOMPurify from "dompurify";

type Props = {
  html?: string | null;
  fallbackText?: string;
};

const PURIFY_OPTS: DOMPurify.Config = {
  ADD_TAGS: ["img", "figure", "section"],
  ADD_ATTR: ["src", "alt", "style", "class", "width", "height"],
};

export default function RequirementRichPreview({ html, fallbackText }: Props) {
  const safe = html?.trim() ? DOMPurify.sanitize(html, PURIFY_OPTS) : "";
  if (safe) {
    return (
      <div
        className="req-rich-preview-host detail-block"
        dangerouslySetInnerHTML={{ __html: safe }}
      />
    );
  }
  if (fallbackText?.trim()) {
    return <pre className="detail-block req-doc-plain">{fallbackText}</pre>;
  }
  return null;
}
