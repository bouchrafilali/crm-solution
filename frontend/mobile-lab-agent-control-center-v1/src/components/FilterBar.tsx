interface FilterOption {
  label: string;
  value: string;
}

interface FilterField {
  id: string;
  label: string;
  value: string;
  options: FilterOption[];
}

interface FilterBarProps {
  fields: FilterField[];
  onChange: (id: string, value: string) => void;
  query?: string;
  onQueryChange?: (value: string) => void;
  queryPlaceholder?: string;
}

export function FilterBar({ fields, onChange, query, onQueryChange, queryPlaceholder = "Search" }: FilterBarProps) {
  return (
    <div className="ml-panel mb-5 flex flex-wrap items-center gap-2 rounded-2xl p-3.5">
      {fields.map((field) => (
        <label key={field.id} className="ml-panel-soft ml-interactive flex items-center gap-2 rounded-xl px-2.5 py-1.5">
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{field.label}</span>
          <select
            className="bg-transparent text-xs font-medium text-slate-200 outline-none"
            value={field.value}
            onChange={(event) => onChange(field.id, event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value} className="bg-slate-950 text-slate-100">
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
      {typeof query === "string" && onQueryChange ? (
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={queryPlaceholder}
          className="ml-panel-soft ml-auto min-w-52 rounded-xl px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none transition focus:border-sky-400/50"
        />
      ) : null}
    </div>
  );
}

export type { FilterField };
