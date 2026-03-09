interface SignalTagProps {
  text: string;
}

export function SignalTag({ text }: SignalTagProps) {
  return (
    <span className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800/70 px-2 py-1 text-xs text-zinc-300">
      {text}
    </span>
  );
}
