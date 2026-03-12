interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ value, onChange, placeholder = "Search modules" }: SearchBarProps) {
  return (
    <label className="group relative ml-auto flex w-full max-w-sm items-center gap-2 rounded-full border border-white/12 bg-white/[0.04] px-3 py-2 backdrop-blur-xl transition hover:border-white/20 md:w-auto">
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="h-4 w-4 text-slate-400 transition group-focus-within:text-cyan-200"
      >
        <path
          d="M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm8.707 15.293-3.4-3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
      />
    </label>
  );
}
