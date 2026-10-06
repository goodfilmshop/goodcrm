// Extract suggestions only from inbound text. Never infer gender from language or a profile.
export function extractLineContactDetails(input) {
  if (typeof input !== 'string') return {};
  const text = input.slice(0, 10000).replace(/[๐-๙]/g, c => String(c.charCodeAt(0) - 3664));
  const result = {};
  const add = (key, value) => {
    if (!value) return;
    const values = result[key] || (result[key] = []);
    if (!values.includes(value) && values.length < 3) values.push(value);
  };
  for (const match of text.matchAll(/(?:^|[^\w+])((?:\+66|0)[\d ()-]{7,20}\d)(?!\w)/g)) {
    const phone = match[1].replace(/[ ()-]/g, '').replace(/^\+66/, '0');
    if (/^(?:0[689]\d{8}|0[2-7]\d{7})$/.test(phone)) add('phone', phone);
  }
  for (const match of text.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g)) {
    if (match[0].length <= 254) add('email', match[0].toLowerCase());
  }
  for (const line of text.split(/[\r\n]+/)) {
    const named = line.trim().match(/^(?:ชื่อ|ชื่อผม|ชื่อของผม|ชื่อฉัน|ชื่อดิฉัน|ชื่อของฉัน|ผมชื่อ|ฉันชื่อ|ดิฉันชื่อ|my name is)\s*[:：]?\s+([\p{L}\p{M} .'-]{1,100})$/iu);
    if (named) {
      const name = named[1].replace(/\s*(?:ครับ|ค่ะ|คะ)\s*$/, '').trim();
      if (name && !/(?:เบอร์|โทร|อีเมล|บริษัท|ลูกค้า|ของแฟน|ของเพื่อน)/.test(name)) add('name', name);
    }
    const gender = line.trim().match(/^เพศ\s*[:：]\s*(ชาย|หญิง)\s*(?:ครับ|ค่ะ|คะ)?$/);
    if (gender) add('gender', gender[1]);
  }
  return result;
}

export function sanitizeLineContactDetails(input) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const key of ['name', 'phone', 'email', 'gender']) {
    if (!Array.isArray(input[key])) continue;
    const values = input[key].filter(v => typeof v === 'string' && v.length > 0 && v.length <= (key === 'email' ? 254 : 100))
      .filter(v => key === 'phone' ? /^(?:0[689]\d{8}|0[2-7]\d{7})$/.test(v)
        : key === 'email' ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
        : key === 'gender' ? ['ชาย', 'หญิง'].includes(v) : /^[\p{L}\p{M} .'-]+$/u.test(v));
    if (values.length) result[key] = [...new Set(values)].slice(0, 3);
  }
  return result;
}
