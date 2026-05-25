import { Slider } from "@/components/ui/slider";

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
  format?: (v: number) => string;
  hint?: string;
}

export function SliderField({ label, value, onChange, min = 0, max = 1, step = 0.01, format, hint }: Props) {
  return (
    <div className="space-y-1.5" title={hint}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground cursor-help">{label}</span>
        <span className="font-mono text-foreground/80">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={(v) => onChange(v[0])} />
    </div>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-foreground/70">{value.toUpperCase()}</span>
        <label className="size-7 rounded-md border border-border cursor-pointer overflow-hidden" style={{ background: value }}>
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="opacity-0 size-0" />
        </label>
      </div>
    </div>
  );
}
