create table if not exists suggestion_learning_settings (
  id int primary key default 1 check (id = 1),
  learning_window_days int not null default 90,
  min_samples int not null default 3,
  success_weight int not null default 20,
  accepted_weight int not null default 10,
  lost_weight int not null default 14,
  boost_min int not null default -15,
  boost_max int not null default 20,
  success_outcomes text[] not null default '{"CONFIRMED","CONVERTED"}',
  failure_outcomes text[] not null default '{"LOST"}',
  updated_at timestamptz not null default now()
);

insert into suggestion_learning_settings (id)
values (1)
on conflict (id) do nothing;
