# GOOD CRM — เตรียมขอสิทธิ์ Meta

สถานะ 17 กันยายน 2026: เอกสารเตรียมงานเท่านั้น ยังไม่ได้ส่งคำขอให้ Meta

## สิทธิ์ที่เกี่ยวข้อง

- `pages_messaging`: รับเหตุการณ์ข้อความเข้าจากเพจที่เจ้าของธุรกิจเชื่อมไว้
- `pages_manage_metadata`: สมัคร Webhook ของเพจที่เลือก
- `pages_show_list`: ให้เจ้าของธุรกิจเลือกเพจที่จะเชื่อม
- **Business Asset User Profile Access — Advanced Access**: อ่านชื่อผู้ที่ทักเพจด้วย User Profile API จำเป็นตามเอกสาร Meta และยังไม่ได้รับอนุมัติ

ตรวจคำขอร่างเดิม 1703248357768175 ก่อนเพิ่มคำขอใหม่ ห้ามลบสิทธิ์อื่นในร่างโดยไม่ทราบว่าระบบเดิมใช้งานหรือไม่

## คำอธิบายการใช้งานสำหรับร่างคำขอ

GOOD CRM is an internal customer management tool for our business. An authorized administrator connects selected Facebook Pages. When a person sends a Messenger message to a connected Page, our signed webhook receiver records the Page-scoped sender ID, message event ID and timestamp. We request the sender's first and last name through the User Profile API so administrators can identify the person in an intake queue.

Incoming contacts are not automatically converted into CRM customers. Administrators continue replying in Meta Business Suite. They explicitly review a contact and choose to create a customer, link an existing customer, or dismiss the contact. This integration does not send automated Messenger replies. The current webhook receiver does not persist message text or attachments.

## ขั้นตอนสาธิตตามระบบที่มีจริง

1. เข้าสู่ระบบ GOOD CRM ด้วยบัญชีทดสอบที่มีสิทธิ์ผู้ดูแลในสภาพแวดล้อมทดสอบ
2. เปิด Facebook รอคัดเข้า และเลือกเพจที่ใช้ทดสอบ
3. ใช้บัญชีทดสอบส่งข้อความเข้าเพจนั้น
4. แสดงรายชื่อผู้ทัก เวลาทักครั้งแรก/ล่าสุด และสถิติใน CRM
5. แสดงการดึงชื่อโปรไฟล์เมื่อแอปมีสิทธิ์ที่จำเป็น หรือชี้แจงข้อจำกัดระหว่างการทดสอบ ห้ามนำชื่อที่กรอกเองมาอ้างเป็นผลดึงอัตโนมัติ
6. เปิด คัดรายชื่อ กรอกข้อมูลที่ทราบ และสาธิตการเพิ่ม/เชื่อมลูกค้าด้วยข้อมูลทดสอบ
7. แสดงว่าแอดมินยังตอบใน Meta Business Suite และการคัดเข้าต้องกดเอง

## สิ่งที่ต้องเตรียมก่อนส่งจริง

- ปัจจุบัน CRM อยู่ที่ localhost:3000 ทีม Meta จึงเปิดจากภายนอกไม่ได้ ต้องจัดสภาพแวดล้อมสาธิตที่เข้าถึงได้ พร้อมบัญชีทดสอบที่ไม่เปิดเผยข้อมูลลูกค้าจริง
- วิดีโอสาธิตขั้นตอนจริงตามสิทธิ์ที่ขอ
- URL นโยบายความเป็นส่วนตัวที่อธิบาย GOOD CRM และการใช้ข้อมูล Facebook จริง ค่าเดิมเป็นหน้าแรก goodfilmshop.com ยังไม่ได้ยืนยันว่าเพียงพอ
- URL คำแนะนำ/ช่องทางลบข้อมูลที่ใช้งานได้ ค่าเดิมเป็นหน้าแรก facebook.com
- ผู้รับผิดชอบและช่องทางติดต่อเพื่อคำขอลบข้อมูล รวมทั้งระยะเวลาเก็บข้อมูลที่ธุรกิจยืนยัน ต้องไม่แต่งนโยบายขึ้นแทนผู้ใช้
- ตรวจรายละเอียดคำขอและข้อตกลงหน้า Submit ก่อนส่งจริง

## ผลตรวจแยกตามปัญหา

การดึงชื่อ: ยืนยันข้อกำหนด Advanced Access แล้ว แต่ไม่ได้รับอนุมัติ จึงยังดึงชื่ออัตโนมัติไม่ได้ในการทดสอบปัจจุบัน

FB-MHL/FB-CAR ไม่เข้าคิว: เพิ่มสิทธิ์และบันทึก subscription ใหม่สำเร็จแล้ว แต่ข้อความทดสอบหลังแก้ยังไม่เข้าฐานข้อมูล จึงยังไม่ยืนยันสาเหตุเดียวหรืออ้างว่า App Review จะแก้ปัญหานี้แน่นอน

แหล่งข้อมูลทางการ:
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/identity/user-profile
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/app-review
