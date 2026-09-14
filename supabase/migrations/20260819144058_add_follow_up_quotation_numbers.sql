alter table public.lead_follow_up_history
  add column quotation_numbers text[] not null default '{}'::text[];

alter table public.lead_follow_up_history
  add constraint lead_follow_up_history_quotation_numbers_required
  check (
    current_status is distinct from 'ส่งใบเสนอราคา'
    or cardinality(quotation_numbers) > 0
  ) not valid;

comment on column public.lead_follow_up_history.quotation_numbers is
  'เลขที่ใบเสนอราคาที่บันทึกพร้อมประวัติการติดตาม; ต้องมีอย่างน้อยหนึ่งค่าเมื่อ current_status เป็น ส่งใบเสนอราคา';
