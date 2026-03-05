alter table if exists quote_actions
  drop constraint if exists quote_actions_action_type_check;

alter table if exists quote_actions
  add constraint quote_actions_action_type_check
  check (action_type in ('APPROVE_PRICE', 'REQUEST_PRICE_EDIT', 'MARK_READY_PIECE', 'PRICE_OVERRIDE', 'MARK_OOS', 'SEND_TO_CLIENT'));
