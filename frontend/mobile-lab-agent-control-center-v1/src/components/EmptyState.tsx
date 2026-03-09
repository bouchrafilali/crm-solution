interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/50 px-6 py-10 text-center">
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      <p className="mt-2 text-sm text-zinc-500">{description}</p>
    </div>
  );
}
