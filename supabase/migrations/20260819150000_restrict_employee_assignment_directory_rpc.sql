-- Existing Supabase projects may explicitly grant new public functions to
-- anon/authenticated through default privileges. Keep this employee lookup
-- callable only by signed-in CRM users.

revoke all on function public.list_crm_employees_by_position(text)
from public, anon, authenticated;

grant execute on function public.list_crm_employees_by_position(text)
to authenticated;
