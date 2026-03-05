insert into reply_templates (stage, language, country_group, template_name, text, enabled)
select
  'PRICE_SENT',
  'FR',
  'MA',
  'ps_confirm_fr_ma',
  'Parfait, nous sommes dans les délais pour {event_date_human}. Le prix est de {price} DHS, avec un délai de confection d’environ {production_time}. Si vous le souhaitez, je peux organiser une courte visio privée.',
  true
where not exists (
  select 1 from reply_templates where template_name = 'ps_confirm_fr_ma'
);

insert into reply_templates (stage, language, country_group, template_name, text, enabled)
select
  'PRICE_SENT',
  'FR',
  'FR',
  'ps_confirm_fr_fr',
  'Parfait, nous sommes dans les délais pour {event_date_human}. Le prix est de {price} EUR, avec un délai de confection d’environ {production_time}. Si vous le souhaitez, je peux organiser une courte visio privée.',
  true
where not exists (
  select 1 from reply_templates where template_name = 'ps_confirm_fr_fr'
);

insert into reply_templates (stage, language, country_group, template_name, text, enabled)
select
  'PRICE_SENT',
  'FR',
  'INTL',
  'ps_confirm_fr_intl',
  'Parfait, nous sommes dans les délais pour {event_date_human}. Le prix est de {price} USD, avec un délai de confection d’environ {production_time}. Si vous le souhaitez, je peux organiser une courte visio privée.',
  true
where not exists (
  select 1 from reply_templates where template_name = 'ps_confirm_fr_intl'
);

insert into stage_template_suggestions (stage, template_name, priority, enabled)
select 'PRICE_SENT', 'ps_confirm_fr_ma', 5, true
where not exists (
  select 1 from stage_template_suggestions where stage = 'PRICE_SENT' and template_name = 'ps_confirm_fr_ma'
);

insert into stage_template_suggestions (stage, template_name, priority, enabled)
select 'PRICE_SENT', 'ps_confirm_fr_fr', 5, true
where not exists (
  select 1 from stage_template_suggestions where stage = 'PRICE_SENT' and template_name = 'ps_confirm_fr_fr'
);

insert into stage_template_suggestions (stage, template_name, priority, enabled)
select 'PRICE_SENT', 'ps_confirm_fr_intl', 5, true
where not exists (
  select 1 from stage_template_suggestions where stage = 'PRICE_SENT' and template_name = 'ps_confirm_fr_intl'
);
