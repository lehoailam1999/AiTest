/**
 * Chọn engine Unit | E2E (và tùy chọn Tất cả) — button pair, không dùng Ant Segmented.
 */
import { Button, Space } from "antd";

export type EnginePickValue = "all" | "unit" | "e2e";

type Option = { value: EnginePickValue; label: string };

type Props = {
  value: EnginePickValue;
  onChange: (v: EnginePickValue) => void;
  options?: Option[];
  disabled?: boolean;
  size?: "small" | "middle";
  "aria-label"?: string;
};

const DEFAULT_OPTIONS: Option[] = [
  { value: "unit", label: "Unit" },
  { value: "e2e", label: "E2E" },
];

export function EnginePicker({
  value,
  onChange,
  options = DEFAULT_OPTIONS,
  disabled,
  size = "middle",
  "aria-label": ariaLabel = "Loại engine",
}: Props) {
  return (
    <Space.Compact className="engine-pick" size={size} aria-label={ariaLabel}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <Button
            key={opt.value}
            type={active ? "primary" : "default"}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
          >
            {opt.label}
          </Button>
        );
      })}
    </Space.Compact>
  );
}
