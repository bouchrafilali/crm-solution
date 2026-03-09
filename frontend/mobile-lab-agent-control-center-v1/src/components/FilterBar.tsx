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
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-3">
      {fields.map((field) => (
        <label key={field.id} className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/70 px-2 py-1.5">
          <span className="text-xs text-zinc-500">{field.label}</span>
          <select
            className="bg-transparent text-xs text-zinc-200 outline-none"
            value={field.value}
            onChange={(event) => onChange(field.id, event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value} className="bg-zinc-900 text-zinc-200">
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
          className="ml-auto min-w-52 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none transition focus:border-zinc-700"
        />
      ) : null}
    </div>
  );
}

export type { FilterField };
