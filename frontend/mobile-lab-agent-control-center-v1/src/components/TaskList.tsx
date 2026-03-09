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
        <div key={task.id} className="ml-panel-soft flex items-center justify-between rounded-xl px-3 py-2">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${task.done ? "bg-emerald-300" : "bg-amber-300"}`} />
            <p className="text-sm text-slate-200">{task.title}</p>
          </div>
          <span className="ml-code text-[11px] text-slate-500">Due {task.due}</span>
        </div>
      ))}
    </div>
  );
}
