import { useRef } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  label: string;
  accept: string;
  value?: { name: string };
  onChange: (file: { name: string; type: string; dataUrl: string }) => void;
}

export function UploadField({ label, accept, value, onChange }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange({ name: file.name, type: file.type, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  };
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</div>
      <Button
        variant="outline"
        onClick={() => ref.current?.click()}
        className="w-full justify-start gap-2 bg-elevated/60 hover:bg-elevated border-border h-10"
      >
        <Upload className="size-4 shrink-0" />
        <span className="truncate text-left">{value?.name || `Upload ${label.toLowerCase()}`}</span>
      </Button>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={handle} />
    </div>
  );
}
