interface SignalTagProps {
  text: string;
}

export function SignalTag({ text }: SignalTagProps) {
  return (
    <span className="ml-chip inline-flex items-center rounded-md px-2 py-1 text-xs text-slate-300">
      {text}
    </span>
  );
}
