let intakeReportRequest = 0;
let intakeReportData = null;
const intakeReportExpandedDays = new Set();
const intakeReportElement = suffix => document.getElementById(`intake-report-${suffix}`);
const intakeReportMetrics = [['new', 'คนทักใหม่'], ['returning', 'คนเดิมทัก'], ['total', 'คนทักทั้งหมด'], ['imported', 'คัดเข้า CRM']];
const intakeReportCompanies = ['GFS', 'MHL', 'CAR'];
const intakeReportNumber = value => Number(value).toLocaleString('th-TH');
const intakeReportDateLabel = date => `${Number(date.slice(8))}/${Number(date.slice(5, 7))}/${date.slice(2, 4)}`;
const canViewIntakeReport = () => window.canViewIntakeChannel?.('line') === true || window.canViewIntakeChannel?.('facebook') === true;
const intakeReportAllowedChannel = channel => window.canViewIntakeChannel?.(channel === 'LINE' ? 'line' : 'facebook') === true;
const intakeReportAllowedAccount = row => window.canViewIntakeChannel?.(row.channel === 'LINE' ? 'line' : 'facebook', row.key) === true;

function resetIntakeReport() {
  intakeReportRequest++;
  intakeReportData = null;
  intakeReportExpandedDays.clear();
  for (const id of ['head', 'body', 'status']) intakeReportElement(id).textContent = '';
  intakeReportElement('refresh').disabled = false;
  intakeReportElement('table').setAttribute('aria-busy', 'false');
}

function intakeReportAccounts(day, company) {
  const channel = intakeReportElement('channel').value;
  return day.accounts.filter(row => intakeReportAllowedAccount(row)
    && (!company || row.company === company) && (!channel || row.channel === channel));
}

function renderIntakeReport() {
  if (!intakeReportData || !canViewIntakeReport()) return;
  const company = intakeReportElement('company').value;
  const { days, month } = intakeReportData;
  const allowedCompanies = new Set(days.flatMap(day => day.accounts.filter(intakeReportAllowedAccount).map(row => row.company)));
  const companies = intakeReportCompanies.filter(item => allowedCompanies.has(item) && (!company || item === company));
  // Retain calendar indexes so drill-downs still open the right day after filtering.
  const visibleDays = days.map((day, dayIndex) => ({ day, dayIndex })).filter(({ day }) =>
    intakeReportAccounts(day, company).some(row => intakeReportMetrics.some(([key]) => row[key] > 0)));
  const visibleDates = new Set(visibleDays.map(({ day }) => day.date));
  for (const date of intakeReportExpandedDays) if (!visibleDates.has(date)) intakeReportExpandedDays.delete(date);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const channels = ['LINE', 'FB'].filter(channel => intakeReportAllowedChannel(channel)
    && (!intakeReportElement('channel').value || channel === intakeReportElement('channel').value));
  intakeReportElement('head').innerHTML = '<tr><th scope="col" class="report-company">บริษัท</th><th scope="col" class="report-metric">รายการ</th>' + visibleDays.map(({ day: { date }, dayIndex }) => {
    const expanded = intakeReportExpandedDays.has(date);
    return `<th scope="col" class="${date === today ? 'report-today' : ''} ${expanded ? 'report-expanded-day' : ''}"><button id="report-toggle-${dayIndex}" type="button" onclick="toggleIntakeReportDay(${dayIndex}, this.id)" aria-expanded="${expanded}" aria-label="${expanded ? 'ยุบ' : 'ขยาย'}ช่องทาง วันที่ ${date}">${intakeReportDateLabel(date)} <span aria-hidden="true">${expanded ? '−' : '+'}</span></button></th>` + (expanded ? channels.map(channel => `<th scope="col" class="report-channel-column report-channel-${channel.toLowerCase()}" aria-label="${channel} วันที่ ${date}">${channel}</th>`).join('') : '');
  }).join('') + '</tr>';
  intakeReportElement('body').innerHTML = visibleDays.length ? companies.map(company => intakeReportMetrics.map(([key, label], index) => `<tr class="${index === 0 ? 'report-group-start' : ''} ${key === 'total' ? 'report-total-row' : ''}">${index === 0 ? `<th scope="rowgroup" rowspan="4" class="report-company">${company}</th>` : ''}<th scope="row" class="report-metric">${label}</th>${visibleDays.map(({ day, dayIndex }) => {
    const accounts = intakeReportAccounts(day, company);
    const count = accounts.reduce((sum, row) => sum + row[key], 0);
    const expanded = intakeReportExpandedDays.has(day.date);
    return `<td class="${day.date === today ? 'report-today' : ''}"><button id="report-value-${dayIndex}-${company}-${key}" type="button" class="${count === 0 ? 'report-zero' : ''}" onclick="toggleIntakeReportDay(${dayIndex}, this.id)" aria-expanded="${expanded}" aria-label="${company} ${label} วันที่ ${day.date}: ${count} ${expanded ? 'ยุบ' : 'ขยาย'}ช่องทาง">${intakeReportNumber(count)}</button></td>` + (expanded ? channels.map(channel => {
      const value = accounts.filter(row => row.channel === channel).reduce((sum, row) => sum + row[key], 0);
      return `<td class="report-channel-column report-channel-${channel.toLowerCase()} ${value === 0 ? 'report-zero' : ''}" aria-label="${company} ${label} ${channel} วันที่ ${day.date}: ${value}">${intakeReportNumber(value)}</td>`;
    }).join('') : '');
  }).join('')}</tr>`).join('')).join('') : '<tr><td colspan="2" class="report-empty">ไม่มีข้อมูลในเดือนนี้ตามตัวกรองที่เลือก</td></tr>';
  intakeReportElement('status').textContent = `เดือน ${Number(month.slice(5))}/${month.slice(0, 4)} (เวลาไทย) · มีข้อมูล ${visibleDays.length} วัน · กด + หรือยอดรวมของวันเพื่อขยาย LINE / FB ทางขวา`;
}

function toggleIntakeReportDay(dayIndex, focusId = '') {
  if (!intakeReportData || !canViewIntakeReport()) return;
  const day = intakeReportData.days[dayIndex];
  if (!day) return;
  if (intakeReportExpandedDays.has(day.date)) intakeReportExpandedDays.delete(day.date);
  else intakeReportExpandedDays.add(day.date);
  const scroll = intakeReportElement('scroll');
  const left = scroll.scrollLeft;
  renderIntakeReport();
  scroll.scrollLeft = left;
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

async function loadIntakeReport() {
  resetIntakeReport();
  const request = intakeReportRequest;
  if (!canViewIntakeReport()) {
    intakeReportElement('status').textContent = 'บัญชีนี้ไม่มีสิทธิ์ดูสรุปการติดต่อ FB และ LINE';
    return;
  }
  const channelFilter = intakeReportElement('channel');
  for (const option of channelFilter.options) {
    if (option.value) option.hidden = option.disabled = !intakeReportAllowedChannel(option.value);
  }
  if (channelFilter.value && !intakeReportAllowedChannel(channelFilter.value)) channelFilter.value = '';
  const monthInput = intakeReportElement('month');
  if (!monthInput.value) monthInput.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).slice(0, 7);
  intakeReportElement('status').textContent = 'กำลังโหลดสรุปรายเดือน…';
  intakeReportElement('refresh').disabled = true;
  intakeReportElement('table').setAttribute('aria-busy', 'true');
  try {
    const url = new URL(config.crmApiUrl);
    url.searchParams.set('action', 'getIntakeReport');
    url.searchParams.set('month', monthInput.value);
    const response = await crmFetch(url.toString(), { cache: 'no-store' });
    const result = await response.json();
    if (request !== intakeReportRequest || !canViewIntakeReport()) return;
    if (!response.ok || !result.success) throw new Error(result.error || 'โหลดสรุปการติดต่อไม่สำเร็จ');
    intakeReportData = result;
    renderIntakeReport();
  } catch (error) {
    if (request === intakeReportRequest) intakeReportElement('status').textContent = error.message;
  } finally {
    if (request === intakeReportRequest) {
      intakeReportElement('refresh').disabled = false;
      intakeReportElement('table').setAttribute('aria-busy', 'false');
    }
  }
}
