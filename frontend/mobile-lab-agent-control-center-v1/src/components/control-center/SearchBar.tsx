import { Search } from "lucide-react";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ value, onChange, placeholder = "Search modules" }: SearchBarProps) {
  return (
    <label className="group relative flex w-full items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-4 py-2.5 backdrop-blur-xl transition hover:border-white/20">
      <Search aria-hidden className="h-4 w-4 text-slate-400 transition group-focus-within:text-cyan-200" strokeWidth={1.8} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
      />
    </label>
  );
}
