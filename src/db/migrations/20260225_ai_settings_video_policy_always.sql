alter table ai_settings
  drop constraint if exists ai_settings_include_video_call_check;

update ai_settings
set include_video_call = 'ALWAYS'
where include_video_call = 'DEFAULT_ON';

alter table ai_settings
  add constraint ai_settings_include_video_call_check
  check (include_video_call in ('NEVER', 'WHEN_HIGH_INTENT', 'ALWAYS'));
