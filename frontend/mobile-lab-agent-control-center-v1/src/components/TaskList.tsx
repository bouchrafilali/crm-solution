interface Task {
  id: string;
  title: string;
  due: string;
  done: boolean;
}

interface TaskListProps {
  tasks: Task[];
}

export function TaskList({ tasks }: TaskListProps) {
  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div key={task.id} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${task.done ? "bg-emerald-400" : "bg-amber-300"}`} />
            <p className="text-sm text-zinc-200">{task.title}</p>
          </div>
          <span className="text-xs text-zinc-500">Due {task.due}</span>
        </div>
      ))}
    </div>
  );
}
