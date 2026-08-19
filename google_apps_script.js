/**
 * Google Apps Script for Good CRM Lead Entry System (Redesigned version)
 * Save this code in Extensions > Apps Script of your Google Spreadsheet.
 * Deploy as a Web App: Execute as "Me", Who has access: "Anyone".
 */

var GOOD_CRM_API_VERSION = "2026-08-19-security-v21";
// Store this value in Apps Script Properties, never in this source file or in
// the browser. Every request is now sent by the authenticated Node.js proxy.
var GOOD_CRM_SHARED_SECRET_PROPERTY = "GOOD_CRM_API_SHARED_SECRET";
// List responses are intentionally short-lived.  Keeping the cache key behind
// a version property lets every write invalidate all list/detail responses
// without trying to enumerate ScriptCache keys (which Apps Script cannot do).
var GOOD_CRM_LEAD_CACHE_SECONDS = 30;
var GOOD_CRM_LEAD_CACHE_VERSION_KEY = "good_crm_lead_cache_version";
// Case counts change only when a case is created, so they can stay warm much
// longer than individual list pages. This prevents every page request from
// scanning the full contact sheet merely to render the count badge.
var GOOD_CRM_CASE_COUNT_CACHE_SECONDS = 300;
var GOOD_CRM_CASE_COUNT_CACHE_VERSION_KEY = "good_crm_case_count_cache_version";
var GOOD_CRM_LEAD_INDEX_SHEET = "_GOOD_CRM_LEAD_INDEX";
var GOOD_CRM_LEAD_INDEX_HEADERS = [
  "Cust_ID", "วันที่บันทึก", "ชื่อลูกค้า", "เพศ", "เบอร์โทรศัพท์",
  "ช่องทางติดต่อ", "ชื่อช่องทางติดต่อ", "รู้จักครั้งแรก", "หมายเหตุ",
  "จำนวนเคส", "Source_Row"
];
var GOOD_CRM_CASE_STATUSES = [
  "ติดต่อสอบถาม",
  "ประเมินราคา",
  "นัดวัดพื้นที่",
  "เสนอราคา",
  "ติดตามครั้งที่ 1",
  "ติดตามครั้งที่ 2",
  "ติดตามครั้งที่ 3",
  "ติดตามครั้งที่ 4",
  "ติดตามครั้งที่ 5",
  "ต่อรองราคา",
  "เซ็นต์สัญญา",
  "มัดจำก่อนติด",
  "นัดคิวติดตั้ง",
  "ติดตั้งสิ้นเสร็จ",
  "ชำระเงินครบ",
  "เก็บซิลิโคลน",
  "ยกเลิก"
];
var CUSTOMER_REMARKS_COLUMN = 9; // Column I (1-based)
// Zero-based positions in the "ข้อมูลการติดต่อ" sheet. Keep this mapping in
// sync with the sheet layout rather than relying on editable header labels.
var CONTACT_CASE_COLUMNS = {
  CASE_ID: 0,          // A
  CUSTOMER_ID: 1,      // B
  RECORDED_AT: 2,      // C
  TOPIC: 4,            // E
  PRIORITY: 5,         // F
  SITE_TYPE: 6,        // G
  SITE_ADDRESS: 7,     // H
  LOCATION: 8,         // I
  PROVINCE: 9,         // J
  JOB_DETAILS: 11,     // L
  ADMIN: 13,           // N
  SALESPERSON: 14,     // O
  COMPANY: 15,         // P
  STATUS: 16,          // Q
  REMARKS: 17,         // R
  CHAT_LINK: 18        // S
};

function doGet(e) {
  try {
    if (!isAuthorizedGoodCrmRequest(e)) return unauthorizedGoodCrmResponse();
    var action = e && e.parameter && e.parameter.action;

    if (action === "getVersion") {
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        apiVersion: GOOD_CRM_API_VERSION
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "lookupCustomer") {
      var lookupSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var lookupSheet = lookupSpreadsheet.getSheetByName("ข้อมูลลูกค้า");
      if (!lookupSheet) {
        throw new Error("Sheet 'ข้อมูลลูกค้า' not found.");
      }

      var lookupResult = lookupCustomers(
        lookupSheet,
        (e.parameter.customerName || "").toString(),
        (e.parameter.phone || "").toString()
      );
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        nameMatches: lookupResult.nameMatches,
        phoneMatches: lookupResult.phoneMatches
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "getCustomer") {
      var customerSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var customerLookupSheet = customerSpreadsheet.getSheetByName("ข้อมูลลูกค้า");
      if (!customerLookupSheet) {
        throw new Error("Sheet 'ข้อมูลลูกค้า' not found.");
      }

      var requestedCustomerId = (e.parameter.customerId || "").toString().trim();
      var requestedRowNumber = findCustomerRowNumberById(customerLookupSheet, requestedCustomerId);
      if (!requestedCustomerId || requestedRowNumber === -1) {
        throw new Error("ไม่พบข้อมูลลูกค้า: " + requestedCustomerId);
      }

      var requestedIndices = getCustomerColumnIndices(customerLookupSheet);
      var requestedRow = customerLookupSheet
        .getRange(requestedRowNumber, 1, 1, customerLookupSheet.getLastColumn())
        .getValues()[0];
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        apiVersion: GOOD_CRM_API_VERSION,
        customer: customerSummaryFromRow(requestedRow, requestedIndices)
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "getEmployees") {
      var employeeSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var employeeSheet = employeeSpreadsheet.getSheetByName("พนักงาน");
      if (!employeeSheet) {
        throw new Error("Sheet 'พนักงาน' not found.");
      }

      var requestedPosition = String((e.parameter && e.parameter.position) || "Admin Sale").trim().toLowerCase();
      var employeeData = employeeSheet.getDataRange().getDisplayValues();
      var nameAliases = ["ชื่อพนักงาน", "ชื่อ-นามสกุล", "ชื่อ นามสกุล", "ชื่อ-สกุล", "ชื่อสกุล", "ชื่อเล่น", "ชื่อ", "name", "employee", "employee name"];
      var positionAliases = ["ตำแหน่ง", "ตำแหน่งงาน", "position", "role", "หน้าที่"];
      var employeeNameIndex = 2; // Col C: ชื่อแอดมิน
      var employeePositionIndex = -1;
      var headerScanLimit = Math.min(employeeData.length, 15);

      for (var headerRowIndex = 0; headerRowIndex < headerScanLimit; headerRowIndex++) {
        var headerCandidate = employeeData[headerRowIndex].map(function(value) {
          return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
        });
        var candidateNameIndex = -1;
        var candidatePositionIndex = -1;

        nameAliases.some(function(alias) {
          candidateNameIndex = headerCandidate.indexOf(alias.toLowerCase());
          return candidateNameIndex !== -1;
        });
        positionAliases.some(function(alias) {
          candidatePositionIndex = headerCandidate.indexOf(alias.toLowerCase());
          return candidatePositionIndex !== -1;
        });

        if (employeeNameIndex === -1 && candidateNameIndex !== -1) employeeNameIndex = candidateNameIndex;
        if (candidatePositionIndex !== -1) employeePositionIndex = candidatePositionIndex;
        if (employeeNameIndex !== -1 && employeePositionIndex !== -1) break;
      }

      // Fallback for sheets without a conventional header row: identify the
      // position column from an actual "Admin Sale" cell, then use the nearest
      // populated text column to its left as the employee name.
      if (employeePositionIndex === -1) {
        employeeData.some(function(row) {
          return row.some(function(value, columnIndex) {
            var normalizedValue = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
            if (normalizedValue === requestedPosition) {
              employeePositionIndex = columnIndex;
              return true;
            }
            return false;
          });
        });
      }

      if (employeeNameIndex === -1 && employeePositionIndex !== -1) {
        for (var candidateColumn = employeePositionIndex - 1; candidateColumn >= 0; candidateColumn--) {
          var hasEmployeeName = employeeData.some(function(row) {
            var position = String(row[employeePositionIndex] || "").replace(/\s+/g, " ").trim().toLowerCase();
            var candidateName = String(row[candidateColumn] || "").trim();
            return position === requestedPosition && candidateName !== "" && !/^\d+$/.test(candidateName);
          });
          if (hasEmployeeName) {
            employeeNameIndex = candidateColumn;
            break;
          }
        }
      }

      if (employeeNameIndex === -1 || employeePositionIndex === -1) {
        throw new Error("ไม่พบคอลัมน์ชื่อพนักงานหรือข้อมูลตำแหน่ง Admin Sale ในชีต 'พนักงาน'");
      }

      var seenEmployeeNames = {};
      var employees = employeeData.reduce(function(list, row) {
        var position = String(row[employeePositionIndex] || "").replace(/\s+/g, " ").trim();
        var name = String(row[employeeNameIndex] || "").trim();
        if (position.toLowerCase() === requestedPosition && name && !seenEmployeeNames[name]) {
          seenEmployeeNames[name] = true;
          list.push({ name: name, position: position });
        }
        return list;
      }, []);

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        employees: employees,
        apiVersion: GOOD_CRM_API_VERSION
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // The case-list page reads its rows directly from the contact sheet.  This
    // deliberately does not depend on the customer list having a matching row,
    // so every recorded contact/case remains visible in the CRM.
    if (action === "getCases") {
      var caseSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var caseContactSheet = caseSpreadsheet.getSheetByName("ข้อมูลการติดต่อ");
      if (!caseContactSheet) {
        throw new Error("Sheet 'ข้อมูลการติดต่อ' not found.");
      }

      var caseHeaders = getHeaders(caseContactSheet);
      var caseRows = [];
      var caseLocationRichTextRows = [];
      if (caseContactSheet.getLastRow() > 1) {
        var caseRange = caseContactSheet
          .getRange(2, 1, caseContactSheet.getLastRow() - 1, caseContactSheet.getLastColumn());
        caseRows = caseRange.getValues();
        caseLocationRichTextRows = caseRange.getRichTextValues();
      }

      var customerDetailsById = getCustomerDetailsById(caseSpreadsheet.getSheetByName("ข้อมูลลูกค้า"));
      var cases = caseRows.map(function(row, rowIndex) {
        var record = rowObjectFromHeaders(caseHeaders, row);
        var customerId = getContactCaseValue(row, CONTACT_CASE_COLUMNS.CUSTOMER_ID);
        var customerDetails = customerDetailsById[String(customerId || "").trim()] || {};
        var customerName = getRecordValue(record, caseHeaders, row, ["ชื่อลูกค้า", "ชื่อลูกค้า/บริษัท"], -1);

        return {
          rowNumber: rowIndex + 2,
          caseId: getContactCaseValue(row, CONTACT_CASE_COLUMNS.CASE_ID),
          customerId: customerId,
          customerName: customerName || customerDetails.name || "",
          customerPhone: customerDetails.phone || "",
          company: getContactCaseValue(row, CONTACT_CASE_COLUMNS.COMPANY),
          topic: getContactCaseValue(row, CONTACT_CASE_COLUMNS.TOPIC),
          status: getContactCaseValue(row, CONTACT_CASE_COLUMNS.STATUS),
          date: getContactCaseValue(row, CONTACT_CASE_COLUMNS.RECORDED_AT),
          admin: getContactCaseValue(row, CONTACT_CASE_COLUMNS.ADMIN),
          customerType: getRecordValue(record, caseHeaders, row, ["ประเภทลูกค้า"], -1),
          priority: getContactCaseValue(row, CONTACT_CASE_COLUMNS.PRIORITY),
          siteType: getContactCaseValue(row, CONTACT_CASE_COLUMNS.SITE_TYPE),
          siteAddress: getContactCaseValue(row, CONTACT_CASE_COLUMNS.SITE_ADDRESS),
          location: getContactLocationValue(row, caseLocationRichTextRows[rowIndex]),
          province: getContactCaseValue(row, CONTACT_CASE_COLUMNS.PROVINCE),
          interests: getRecordValue(record, caseHeaders, row, ["สินค้าที่สนใจ"], -1),
          jobDetails: getContactCaseValue(row, CONTACT_CASE_COLUMNS.JOB_DETAILS),
          budget: getRecordValue(record, caseHeaders, row, ["งบประมาณ"], -1),
          salesperson: getContactCaseValue(row, CONTACT_CASE_COLUMNS.SALESPERSON),
          remarks: getContactCaseValue(row, CONTACT_CASE_COLUMNS.REMARKS),
          chatLink: getContactCaseValue(row, CONTACT_CASE_COLUMNS.CHAT_LINK),
          link: getRecordValue(record, caseHeaders, row, ["ลิงก์", "Link", "URL"], -1)
        };
      }).filter(function(item) {
        return [item.caseId, item.customerId, item.topic, item.company, item.status]
          .some(function(value) { return String(value || "").trim() !== ""; });
      });

      cases.sort(function(a, b) {
        return getDateTimestamp(b.date) - getDateTimestamp(a.date);
      });

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        cases: cases,
        apiVersion: GOOD_CRM_API_VERSION
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    if (action === "getLeads") {
      var leadsSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var leadsResponse = getPagedLeads(leadsSpreadsheet, e.parameter || {});
      return ContentService.createTextOutput(JSON.stringify(leadsResponse))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // A customer timeline can be much larger than its list row.  It is loaded
    // only when the detail drawer is opened, never with every list page.
    if (action === "getLeadDetail") {
      var detailSpreadsheet = SpreadsheetApp.getActiveSpreadsheet();
      var customerIdForDetail = String((e.parameter && e.parameter.customerId) || "").trim();
      if (!customerIdForDetail) throw new Error("กรุณาระบุรหัสลูกค้า");
      var detailResponse = getLeadDetail(detailSpreadsheet, customerIdForDetail);
      return ContentService.createTextOutput(JSON.stringify(detailResponse))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Good CRM Leads API is running!"
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error("No data received in post request.");
    }
    
    var data = JSON.parse(e.postData.contents);
    if (!isAuthorizedGoodCrmRequest(e, data)) return unauthorizedGoodCrmResponse();
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.action === "updateCaseStatus") {
      return updateCaseStatus(ss, data);
    }
    if (data.action === "updateCaseDetails") {
      return updateCaseDetails(ss, data);
    }
    
    // 1. WRITE TO ข้อมูลลูกค้า (Customer Info)
    var customerSheet = ss.getSheetByName("ข้อมูลลูกค้า");
    if (!customerSheet) {
      throw new Error("Sheet 'ข้อมูลลูกค้า' not found.");
    }
    
    // Serialize write requests so two users cannot save the same phone at once.
    var writeLock = LockService.getScriptLock();
    writeLock.waitLock(30000);
    try {
      var custId = (data.customerId || "").toString().trim();
      var timestamp = new Date();
      var customerHeaders = getHeaders(customerSheet);
      var normalizedPhone = normalizePhone(data.phone);
      var customerRemarks = getPayloadText(data, ["customerRemarks", "customerNote"]);

      if (!isValidThaiPhone(normalizedPhone)) {
        throw new Error("กรุณากรอกเบอร์มือถือ 10 หลัก หรือโทรศัพท์บ้าน 02 จำนวน 9 หลัก");
      }

      var existingPhoneCustomer = findCustomerByPhone(customerSheet, normalizedPhone);
      if (existingPhoneCustomer && existingPhoneCustomer.custId !== custId) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          code: "DUPLICATE_PHONE",
          error: "เบอร์โทรนี้มีอยู่ในระบบแล้ว",
          existingCustomer: existingPhoneCustomer
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var customerRow;
      var customerRowNumber = -1;
      if (!custId) {
        custId = generateCustomerId(customerSheet);
        customerRow = new Array(customerHeaders.length).fill("");
        setRowValue(customerHeaders, customerRow, "Cust_ID", custId);
        setRowValue(customerHeaders, customerRow, "วันที่บันทึก", timestamp);
      } else {
        customerRowNumber = findCustomerRowNumberById(customerSheet, custId);
        if (customerRowNumber === -1) {
          throw new Error("ไม่พบรหัสลูกค้าที่ต้องการแก้ไข: " + custId);
        }
        customerRow = customerSheet.getRange(customerRowNumber, 1, 1, customerHeaders.length).getValues()[0];
      }

      setRowValue(customerHeaders, customerRow, "ชื่อลูกค้า", data.customerName || "");
      setRowValue(customerHeaders, customerRow, "เพศ", data.gender || "ไม่ระบุ");
      setRowValue(customerHeaders, customerRow, "เบอร์โทรศัพท์", formatThaiPhone(normalizedPhone));
      setRowValue(customerHeaders, customerRow, "ช่องทางติดต่อ", data.contactChannel || "");
      setRowValue(customerHeaders, customerRow, "ชื่อช่องทางติดต่อ", data.contactHandle || "");
      setRowValue(customerHeaders, customerRow, "รู้จักครั้งแรก", data.referralDate || "");
      setCustomerRemarksByColumn(customerRow, customerRemarks);

      if (customerRowNumber === -1) {
        customerSheet.appendRow(customerRow);
      } else {
        customerSheet.getRange(customerRowNumber, 1, 1, customerHeaders.length).setValues([customerRow]);
      }
      upsertLeadIndexCustomer(
        ss,
        customerHeaders,
        customerRow,
        customerRowNumber === -1 ? customerSheet.getLastRow() : customerRowNumber
      );
      // List and detail caches must never outlive a customer write.
      invalidateLeadCaches();

      // Card 1 saves only the customer record, then the app unlocks card 2.
      if (data.action === "saveCustomer") {
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          message: "Customer saved successfully!",
          custId: custId,
          updated: customerRowNumber !== -1,
          customerRemarks: customerRemarks,
          apiVersion: GOOD_CRM_API_VERSION
        })).setMimeType(ContentService.MimeType.JSON);
      }
    
      // 2. WRITE TO ข้อมูลการติดต่อ (Contact Info)
      var contactSheet = ss.getSheetByName("ข้อมูลการติดต่อ");
      if (!contactSheet) {
        throw new Error("Sheet 'ข้อมูลการติดต่อ' not found.");
      }
    
      var contactHeaders = getHeaders(contactSheet);
      var requestId = String(data.caseRequestId || "").trim();
      var requestCache = CacheService.getScriptCache();
      var requestCacheKey = requestId ? "good_crm_case_" + requestId : "";
      var cachedCaseId = requestCacheKey ? requestCache.get(requestCacheKey) : "";
      if (cachedCaseId) {
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          duplicatePrevented: true,
          custId: custId,
          caseId: cachedCaseId,
          logId: cachedCaseId,
          apiVersion: GOOD_CRM_API_VERSION
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var duplicateCase = findRecentDuplicateCase(contactSheet, contactHeaders, data, custId, timestamp);
      if (duplicateCase) {
        var existingCaseId = duplicateCase.caseId;
        if (!existingCaseId) {
          existingCaseId = generateCaseId(contactSheet, contactHeaders);
          contactSheet.getRange(duplicateCase.rowNumber, contactHeaders.indexOf("Case_ID") + 1).setValue(existingCaseId);
        }
        if (requestCacheKey) requestCache.put(requestCacheKey, existingCaseId, 21600);
        return ContentService.createTextOutput(JSON.stringify({
          success: true,
          duplicatePrevented: true,
          custId: custId,
          caseId: existingCaseId,
          logId: existingCaseId,
          apiVersion: GOOD_CRM_API_VERSION
        })).setMimeType(ContentService.MimeType.JSON);
      }

      var caseId = generateCaseId(contactSheet, contactHeaders);
      var contactRow = new Array(contactHeaders.length).fill("");
      if (data.link && contactHeaders.indexOf("ลิงก์") === -1) {
        contactSheet.getRange(1, contactHeaders.length + 1).setValue("ลิงก์");
        contactHeaders.push("ลิงก์");
        contactRow.push("");
      }
    
      setRowValue(contactHeaders, contactRow, "Case_ID", caseId);
      setRowValue(contactHeaders, contactRow, "Log_ID", caseId);
      setRowValue(contactHeaders, contactRow, "Cust_ID", custId);
      setRowValue(contactHeaders, contactRow, "Cut_ID", custId);
      setRowValue(contactHeaders, contactRow, "วันที่บันทึก", timestamp);
      setRowValue(contactHeaders, contactRow, "แอดมิน", data.adminName || "");
      setRowValue(contactHeaders, contactRow, "ประเภทลูกค้า", data.customerType || "");
      setRowValue(contactHeaders, contactRow, "หัวข้อที่ติดต่อ", data.topic || "");
      setRowValue(contactHeaders, contactRow, "ความสำคัญ", data.priority || "");
      setRowValue(contactHeaders, contactRow, "ประเภทหน้างาน", data.siteType || "");
      setRowValue(contactHeaders, contactRow, "ที่อยู่หน้างาน", data.siteAddress || "");
      setRowValue(contactHeaders, contactRow, "จังหวัด", data.province || "");
      setRowValue(contactHeaders, contactRow, "สินค้าที่สนใจ", data.interests || "");
      setRowValue(contactHeaders, contactRow, "รายละเอียดงาน", data.jobDetails || "");
      setRowValue(contactHeaders, contactRow, "งบประมาณ", data.budget || "");
      setRowValue(contactHeaders, contactRow, "ฝ่ายขาย", data.salesperson || "");
      setRowValue(contactHeaders, contactRow, "บริษัท", data.company || data.billingName || "");
      setRowValue(contactHeaders, contactRow, "สถานะงาน", data.jobStatus || "");
      setRowValue(contactHeaders, contactRow, "ลิงก์", data.link || "");
      setRowValue(contactHeaders, contactRow, "ชื่อ/บริษัทออกบิล", data.billingName || "");
      setRowValue(contactHeaders, contactRow, "ที่อยู่สำหรับออกบิล", data.billingAddress || "");
      setRowValue(contactHeaders, contactRow, "เลขประจำตัวผู้เสียภาษี", data.taxId || "");
    
      // Keep the sheet's remarks column focused on user-entered case notes.
      var formattedRemarks = [];
      if (data.remarks) formattedRemarks.push(data.remarks);
      if (data.billingRemarks) formattedRemarks.push("หมายเหตุบิล: " + data.billingRemarks);
    
      setRowValue(contactHeaders, contactRow, "หมายเหตุ", formattedRemarks.join("\n"));
      // Keep the workflow status in the sheet's designated status column (Col Q).
      contactRow[16] = data.jobStatus || contactRow[16] || "";
    
      contactSheet.appendRow(contactRow);
      var appendedRowNumber = contactSheet.getLastRow();
      var caseIdColumn = contactHeaders.indexOf("Case_ID") + 1;
      contactSheet.getRange(appendedRowNumber, caseIdColumn).setValue(caseId);
      SpreadsheetApp.flush();
      incrementLeadIndexCaseCount(ss, custId);
      invalidateCaseCountCache();
      if (requestCacheKey) requestCache.put(requestCacheKey, caseId, 21600);
    
      var response = {
        success: true,
        message: "Lead saved successfully!",
        custId: custId,
        caseId: caseId,
        logId: caseId,
        apiVersion: GOOD_CRM_API_VERSION
      };
    
      return ContentService.createTextOutput(JSON.stringify(response))
        .setMimeType(ContentService.MimeType.JSON);
    } finally {
      writeLock.releaseLock();
    }
      
  } catch (err) {
    var errResponse = {
      success: false,
      error: err.toString()
    };
    return ContentService.createTextOutput(JSON.stringify(errResponse))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function isAuthorizedGoodCrmRequest(e, data) {
  var expectedSecret = PropertiesService.getScriptProperties()
    .getProperty(GOOD_CRM_SHARED_SECRET_PROPERTY);
  if (!expectedSecret) return false;

  var suppliedSecret = data && data.apiKey;
  if (suppliedSecret === undefined && e && e.parameter) suppliedSecret = e.parameter.apiKey;
  return typeof suppliedSecret === "string" && suppliedSecret === expectedSecret;
}

function unauthorizedGoodCrmResponse() {
  return ContentService.createTextOutput(JSON.stringify({
    success: false,
    code: "UNAUTHORIZED",
    error: "Unauthorized request."
  })).setMimeType(ContentService.MimeType.JSON);
}

function getLeadListQuery(parameters) {
  var page = parseInt(parameters.page, 10);
  var pageSize = parseInt(parameters.pageSize, 10);
  return {
    page: isNaN(page) || page < 1 ? 1 : page,
    pageSize: isNaN(pageSize) ? 50 : Math.max(10, Math.min(pageSize, 100)),
    search: String(parameters.search || "").trim().toLowerCase().slice(0, 100),
    gender: String(parameters.gender || "").trim(),
    channel: normalizeLeadChannel(parameters.channel || "")
  };
}

function normalizeLeadChannel(value) {
  var channel = String(value || "").trim().toLowerCase();
  var aliases = {
    "walk in": "walkin",
    "walk-in": "walkin",
    "facebook ads": "facebook",
    "line official": "line",
    "อื่นๆ (other)": "อื่นๆ"
  };
  return aliases[channel] || channel;
}

function getCustomerListColumnIndices(headers) {
  return {
    custId: headers.indexOf("Cust_ID"),
    recordedAt: headers.indexOf("วันที่บันทึก"),
    customerName: headers.indexOf("ชื่อลูกค้า"),
    gender: headers.indexOf("เพศ"),
    phone: headers.indexOf("เบอร์โทรศัพท์"),
    contactChannel: headers.indexOf("ช่องทางติดต่อ"),
    contactHandle: headers.indexOf("ชื่อช่องทางติดต่อ"),
    referralDate: headers.indexOf("รู้จักครั้งแรก"),
    customerRemarks: CUSTOMER_REMARKS_COLUMN - 1
  };
}

function getRowValue(row, index) {
  return index >= 0 && index < row.length ? row[index] : "";
}

function customerListItemFromRow(row, indices, caseCount) {
  return {
    "Cust_ID": getRowValue(row, indices.custId),
    "วันที่บันทึก": getRowValue(row, indices.recordedAt),
    "ชื่อลูกค้า": getRowValue(row, indices.customerName),
    "เพศ": getRowValue(row, indices.gender) || "ไม่ระบุ",
    "เบอร์โทรศัพท์": getRowValue(row, indices.phone),
    "ช่องทางติดต่อ": getRowValue(row, indices.contactChannel),
    "ชื่อช่องทางติดต่อ": getRowValue(row, indices.contactHandle),
    "รู้จักครั้งแรก": getRowValue(row, indices.referralDate),
    // The customer note is defined by the sheet layout and must come from Col I.
    "หมายเหตุ": getRowValue(row, indices.customerRemarks),
    "จำนวนเคส": caseCount || 0
  };
}

function isLeadListItemMatch(item, query) {
  if (query.gender && String(item["เพศ"] || "ไม่ระบุ").trim() !== query.gender) return false;
  if (query.channel && normalizeLeadChannel(item["ช่องทางติดต่อ"]) !== query.channel) return false;
  if (!query.search) return true;

  var searchableText = [
    item["Cust_ID"],
    item["ชื่อลูกค้า"],
    item["เบอร์โทรศัพท์"],
    item["ช่องทางติดต่อ"],
    item["ชื่อช่องทางติดต่อ"],
    item["รู้จักครั้งแรก"],
    item["หมายเหตุ"]
  ].map(function(value) {
    return String(value == null ? "" : value).toLowerCase();
  }).join(" ");
  return searchableText.indexOf(query.search) !== -1;
}

function isLeadIndexReady(indexSheet) {
  if (!indexSheet || indexSheet.getLastColumn() < GOOD_CRM_LEAD_INDEX_HEADERS.length) return false;
  var headers = indexSheet
    .getRange(1, 1, 1, GOOD_CRM_LEAD_INDEX_HEADERS.length)
    .getDisplayValues()[0];
  return GOOD_CRM_LEAD_INDEX_HEADERS.every(function(header, index) {
    return String(headers[index] || "").trim() === header;
  });
}

function getLeadIndexSheetForRead(ss) {
  var indexSheet = ss.getSheetByName(GOOD_CRM_LEAD_INDEX_SHEET);
  return isLeadIndexReady(indexSheet) ? indexSheet : null;
}

function leadListItemFromIndexRow(row) {
  return {
    "Cust_ID": row[0] || "",
    "วันที่บันทึก": row[1] || "",
    "ชื่อลูกค้า": row[2] || "",
    "เพศ": row[3] || "ไม่ระบุ",
    "เบอร์โทรศัพท์": row[4] || "",
    "ช่องทางติดต่อ": row[5] || "",
    "ชื่อช่องทางติดต่อ": row[6] || "",
    "รู้จักครั้งแรก": row[7] || "",
    "หมายเหตุ": row[8] || "",
    "จำนวนเคส": Number(row[9]) || 0
  };
}

function leadIndexRowFromCustomerRow(customerRow, customerIndices, caseCount, sourceRow) {
  var item = customerListItemFromRow(customerRow, customerIndices, caseCount);
  return [
    item["Cust_ID"], item["วันที่บันทึก"], item["ชื่อลูกค้า"], item["เพศ"],
    item["เบอร์โทรศัพท์"], item["ช่องทางติดต่อ"], item["ชื่อช่องทางติดต่อ"],
    item["รู้จักครั้งแรก"], item["หมายเหตุ"], item["จำนวนเคส"], sourceRow
  ];
}

function getPagedLeadsFromIndex(indexSheet, query, cacheVersion, cacheKey) {
  var lastRow = indexSheet.getLastRow();
  var total = Math.max(0, lastRow - 1);
  var totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  var page = Math.min(query.page, totalPages);
  var hasFilters = Boolean(query.search || query.gender || query.channel);
  var leads = [];

  if (!hasFilters) {
    var newestRow = lastRow - ((page - 1) * query.pageSize);
    var pageRowCount = Math.max(0, Math.min(query.pageSize, newestRow - 1));
    if (pageRowCount) {
      var pageStartRow = newestRow - pageRowCount + 1;
      leads = indexSheet
        .getRange(pageStartRow, 1, pageRowCount, GOOD_CRM_LEAD_INDEX_HEADERS.length)
        .getValues()
        .reverse()
        .map(leadListItemFromIndexRow);
    }
  } else {
    var filteredLeads = lastRow > 1
      ? indexSheet
        .getRange(2, 1, lastRow - 1, GOOD_CRM_LEAD_INDEX_HEADERS.length)
        .getValues()
        .map(leadListItemFromIndexRow)
        .filter(function(item) { return isLeadListItemMatch(item, query); })
      : [];
    filteredLeads.sort(function(a, b) {
      return getDateTimestamp(b["วันที่บันทึก"]) - getDateTimestamp(a["วันที่บันทึก"]);
    });
    total = filteredLeads.length;
    totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    page = Math.min(query.page, totalPages);
    leads = filteredLeads.slice((page - 1) * query.pageSize, page * query.pageSize);
  }

  var response = {
    success: true,
    leads: leads,
    pagination: { page: page, pageSize: query.pageSize, total: total, totalPages: totalPages },
    cacheVersion: cacheVersion,
    apiVersion: GOOD_CRM_API_VERSION
  };
  cacheLeadResponse(cacheKey, response);
  return response;
}

// Run this manually once from the Apps Script editor after deployment. It
// creates a compact, hidden read model that keeps list traffic away from the
// two operational sheets. Future CRM writes maintain the affected index row.
function rebuildGoodCrmLeadIndex() {
  return rebuildLeadIndex(SpreadsheetApp.getActiveSpreadsheet());
}

function rebuildLeadIndex(ss) {
  var customerSheet = ss.getSheetByName("ข้อมูลลูกค้า");
  if (!customerSheet) throw new Error("Sheet 'ข้อมูลลูกค้า' not found.");
  var customerHeaders = getHeaders(customerSheet);
  var customerIndices = getCustomerListColumnIndices(customerHeaders);
  if (customerIndices.custId === -1) throw new Error("Column 'Cust_ID' not found.");
  var customerRows = customerSheet.getLastRow() > 1
    ? customerSheet.getRange(2, 1, customerSheet.getLastRow() - 1, customerSheet.getLastColumn()).getValues()
    : [];
  var caseCounts = getCaseCountByCustomer(ss.getSheetByName("ข้อมูลการติดต่อ"));
  var indexRows = customerRows.reduce(function(rows, customerRow, index) {
    var customerId = String(getRowValue(customerRow, customerIndices.custId) || "").trim();
    if (customerId) rows.push(leadIndexRowFromCustomerRow(customerRow, customerIndices, caseCounts[customerId] || 0, index + 2));
    return rows;
  }, []);

  var indexSheet = ss.getSheetByName(GOOD_CRM_LEAD_INDEX_SHEET);
  if (!indexSheet) indexSheet = ss.insertSheet(GOOD_CRM_LEAD_INDEX_SHEET);
  indexSheet.clearContents();
  indexSheet.getRange(1, 1, 1, GOOD_CRM_LEAD_INDEX_HEADERS.length).setValues([GOOD_CRM_LEAD_INDEX_HEADERS]);
  if (indexRows.length) {
    indexSheet.getRange(2, 1, indexRows.length, GOOD_CRM_LEAD_INDEX_HEADERS.length).setValues(indexRows);
  }
  if (typeof indexSheet.hideSheet === "function") indexSheet.hideSheet();
  invalidateLeadCaches();
  return { success: true, indexedCustomers: indexRows.length, sheet: GOOD_CRM_LEAD_INDEX_SHEET };
}

function upsertLeadIndexCustomer(ss, customerHeaders, customerRow, sourceRow) {
  var indexSheet = getLeadIndexSheetForRead(ss);
  if (!indexSheet) return;
  var customerIndices = getCustomerListColumnIndices(customerHeaders);
  var customerId = String(getRowValue(customerRow, customerIndices.custId) || "").trim();
  if (!customerId) return;
  var matchingRows = findSheetRowsByExactValue(indexSheet, 0, customerId);
  var caseCount = 0;
  if (matchingRows.length) {
    caseCount = Number(indexSheet.getRange(matchingRows[0], 10, 1, 1).getValue()) || 0;
  }
  var indexRow = leadIndexRowFromCustomerRow(customerRow, customerIndices, caseCount, sourceRow);
  if (matchingRows.length) {
    indexSheet.getRange(matchingRows[0], 1, 1, indexRow.length).setValues([indexRow]);
  } else {
    indexSheet.appendRow(indexRow);
  }
}

function incrementLeadIndexCaseCount(ss, customerId) {
  var indexSheet = getLeadIndexSheetForRead(ss);
  if (!indexSheet) return;
  var matchingRows = findSheetRowsByExactValue(indexSheet, 0, customerId);
  if (!matchingRows.length) return;
  var countRange = indexSheet.getRange(matchingRows[0], 10, 1, 1);
  countRange.setValue((Number(countRange.getValue()) || 0) + 1);
}

function getCaseCountByCustomer(contactSheet) {
  if (!contactSheet || contactSheet.getLastRow() <= 1) return {};
  var cacheKey = getLeadCacheKey("case_counts", [getCaseCountCacheVersion()]);
  var cachedCounts = getCachedLeadResponse(cacheKey);
  if (cachedCounts) return cachedCounts;

  // Reading only the Cust_ID column avoids building every timeline for a list
  // request.  Full case rows are read only in getLeadDetail(). This one-column
  // scan is cached independently of customer edits.
  var counts = {};
  var customerIds = contactSheet
    .getRange(2, CONTACT_CASE_COLUMNS.CUSTOMER_ID + 1, contactSheet.getLastRow() - 1, 1)
    .getDisplayValues();
  customerIds.forEach(function(row) {
    var customerId = String(row[0] || "").trim();
    if (customerId) counts[customerId] = (counts[customerId] || 0) + 1;
  });
  cacheLeadResponse(cacheKey, counts, GOOD_CRM_CASE_COUNT_CACHE_SECONDS);
  return counts;
}

function getLeadCacheVersion() {
  return PropertiesService.getScriptProperties().getProperty(GOOD_CRM_LEAD_CACHE_VERSION_KEY) || "0";
}

function invalidateLeadCaches() {
  var properties = PropertiesService.getScriptProperties();
  var nextVersion = new Date().getTime();
  var previousVersion = Number(properties.getProperty(GOOD_CRM_LEAD_CACHE_VERSION_KEY)) || 0;
  properties.setProperty(GOOD_CRM_LEAD_CACHE_VERSION_KEY, String(Math.max(nextVersion, previousVersion + 1)));
}

function getCaseCountCacheVersion() {
  return PropertiesService.getScriptProperties().getProperty(GOOD_CRM_CASE_COUNT_CACHE_VERSION_KEY) || "0";
}

function invalidateCaseCountCache() {
  var properties = PropertiesService.getScriptProperties();
  var nextVersion = new Date().getTime();
  var previousVersion = Number(properties.getProperty(GOOD_CRM_CASE_COUNT_CACHE_VERSION_KEY)) || 0;
  properties.setProperty(GOOD_CRM_CASE_COUNT_CACHE_VERSION_KEY, String(Math.max(nextVersion, previousVersion + 1)));
}

function getLeadCacheKey(kind, parts) {
  var encoded = JSON.stringify(parts);
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, encoded);
  var hash = "";
  for (var index = 0; index < digest.length; index++) {
    var value = digest[index];
    var normalized = value < 0 ? value + 256 : value;
    hash += (normalized < 16 ? "0" : "") + normalized.toString(16);
  }
  return "good_crm_" + kind + "_" + hash;
}

function getCachedLeadResponse(cacheKey) {
  try {
    var cached = CacheService.getScriptCache().get(cacheKey);
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    // A cache miss must never make the customer list unavailable.
    return null;
  }
}

function cacheLeadResponse(cacheKey, response, ttlSeconds) {
  var serialized = JSON.stringify(response);
  // ScriptCache allows at most 100 KB per value.  A page is normally far below
  // that; very large customer histories simply skip cache rather than fail.
  if (Utilities.newBlob(serialized).getBytes().length < 90000) {
    try {
      CacheService.getScriptCache().put(cacheKey, serialized, ttlSeconds || GOOD_CRM_LEAD_CACHE_SECONDS);
    } catch (error) {
      // The uncached response is still valid if a temporary cache quota is hit.
    }
  }
}

function getPagedLeads(ss, parameters) {
  var query = getLeadListQuery(parameters);
  var cacheVersion = getLeadCacheVersion();
  var cacheKey = getLeadCacheKey("leads", [cacheVersion, query]);
  var cachedResponse = getCachedLeadResponse(cacheKey);
  if (cachedResponse) return cachedResponse;

  // Once the compact read model has been built, list requests never need to
  // touch the customer or contact source sheets.
  var indexSheet = getLeadIndexSheetForRead(ss);
  if (indexSheet) return getPagedLeadsFromIndex(indexSheet, query, cacheVersion, cacheKey);

  var customerSheet = ss.getSheetByName("ข้อมูลลูกค้า");
  if (!customerSheet) throw new Error("Sheet 'ข้อมูลลูกค้า' not found.");
  var customerHeaders = getHeaders(customerSheet);
  var customerIndices = getCustomerListColumnIndices(customerHeaders);
  if (customerIndices.custId === -1) throw new Error("Column 'Cust_ID' not found.");

  var caseCounts = getCaseCountByCustomer(ss.getSheetByName("ข้อมูลการติดต่อ"));
  var customerLastRow = customerSheet.getLastRow();
  var customerLastColumn = customerSheet.getLastColumn();
  var hasFilters = Boolean(query.search || query.gender || query.channel);
  var customers = [];
  var total;
  var totalPages;
  var page;

  if (!hasFilters) {
    // Customer rows are appended chronologically. Read only the requested
    // physical page from the bottom of the sheet instead of loading and sorting
    // every customer on every initial page visit.
    total = Math.max(0, customerLastRow - 1);
    totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    page = Math.min(query.page, totalPages);
    var newestRow = customerLastRow - ((page - 1) * query.pageSize);
    var pageRowCount = Math.max(0, Math.min(query.pageSize, newestRow - 1));
    if (pageRowCount) {
      var pageStartRow = newestRow - pageRowCount + 1;
      var customerPageRows = customerSheet
        .getRange(pageStartRow, 1, pageRowCount, customerLastColumn)
        .getValues();
      customerPageRows.reverse().forEach(function(row) {
        var customerId = String(getRowValue(row, customerIndices.custId) || "").trim();
        if (customerId) customers.push(customerListItemFromRow(row, customerIndices, caseCounts[customerId] || 0));
      });
      customers.sort(function(a, b) {
        return getDateTimestamp(b["วันที่บันทึก"]) - getDateTimestamp(a["วันที่บันทึก"]);
      });
    }
  } else {
    // A filtered search is less common; keep its exact total/page count while
    // caching the compact result to make repeated filter changes inexpensive.
    var customerRows = customerLastRow > 1
      ? customerSheet.getRange(2, 1, customerLastRow - 1, customerLastColumn).getValues()
      : [];
    var filteredCustomers = customerRows.map(function(row) {
      var customerId = String(getRowValue(row, customerIndices.custId) || "").trim();
      return customerListItemFromRow(row, customerIndices, caseCounts[customerId] || 0);
    }).filter(function(customer) {
      return String(customer["Cust_ID"] || "").trim() !== "" && isLeadListItemMatch(customer, query);
    });
    filteredCustomers.sort(function(a, b) {
      return getDateTimestamp(b["วันที่บันทึก"]) - getDateTimestamp(a["วันที่บันทึก"]);
    });
    total = filteredCustomers.length;
    totalPages = Math.max(1, Math.ceil(total / query.pageSize));
    page = Math.min(query.page, totalPages);
    customers = filteredCustomers.slice((page - 1) * query.pageSize, page * query.pageSize);
  }

  var response = {
    success: true,
    leads: customers,
    pagination: {
      page: page,
      pageSize: query.pageSize,
      total: total,
      totalPages: totalPages
    },
    cacheVersion: cacheVersion,
    apiVersion: GOOD_CRM_API_VERSION
  };
  cacheLeadResponse(cacheKey, response);
  return response;
}

function findSheetRowsByExactValue(sheet, zeroBasedColumnIndex, value) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1 || zeroBasedColumnIndex < 0) return [];
  var valueRange = sheet.getRange(2, zeroBasedColumnIndex + 1, lastRow - 1, 1);

  // TextFinder performs the lookup inside Sheets, so a detail view does not
  // need to transfer every customer/contact row to Apps Script first.
  if (typeof valueRange.createTextFinder === "function") {
    var finder = valueRange.createTextFinder(String(value));
    if (finder && typeof finder.matchEntireCell === "function") finder.matchEntireCell(true);
    if (finder && typeof finder.findAll === "function") {
      return finder.findAll().map(function(match) { return match.getRow(); });
    }
  }

  // Keep a safe fallback for spreadsheet runtimes where TextFinder is absent.
  return valueRange.getDisplayValues().reduce(function(rows, row, index) {
    if (String(row[0] || "").trim() === String(value).trim()) rows.push(index + 2);
    return rows;
  }, []);
}

function getLeadDetail(ss, customerId) {
  var cacheVersion = getLeadCacheVersion();
  var cacheKey = getLeadCacheKey("lead_detail", [cacheVersion, customerId]);
  var cachedResponse = getCachedLeadResponse(cacheKey);
  if (cachedResponse) return cachedResponse;

  var customerSheet = ss.getSheetByName("ข้อมูลลูกค้า");
  if (!customerSheet) throw new Error("Sheet 'ข้อมูลลูกค้า' not found.");
  var customerHeaders = getHeaders(customerSheet);
  var customerIndices = getCustomerListColumnIndices(customerHeaders);
  if (customerIndices.custId === -1) throw new Error("Column 'Cust_ID' not found.");
  var matchingCustomerRows = findSheetRowsByExactValue(customerSheet, customerIndices.custId, customerId);
  if (!matchingCustomerRows.length) throw new Error("ไม่พบข้อมูลลูกค้า: " + customerId);
  var customerRow = customerSheet
    .getRange(matchingCustomerRows[0], 1, 1, customerSheet.getLastColumn())
    .getValues()[0];

  var timeline = [];
  var contactSheet = ss.getSheetByName("ข้อมูลการติดต่อ");
  if (contactSheet && contactSheet.getLastRow() > 1) {
    var contactHeaders = getHeaders(contactSheet);
    var matchingContactRows = findSheetRowsByExactValue(contactSheet, CONTACT_CASE_COLUMNS.CUSTOMER_ID, customerId);
    matchingContactRows.forEach(function(rowNumber) {
      var contactRange = contactSheet.getRange(rowNumber, 1, 1, contactSheet.getLastColumn());
      var contactRow = contactRange.getValues()[0];
      var contactLocationRichTextRow = typeof contactRange.getRichTextValues === "function"
        ? contactRange.getRichTextValues()[0]
        : [];
      var contactRecord = rowObjectFromHeaders(contactHeaders, contactRow);
      timeline.push({
        status: String(getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.STATUS) || "ไม่ระบุสถานะ").trim(),
        date: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.RECORDED_AT),
        admin: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.ADMIN),
        logId: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.CASE_ID),
        customerType: getRecordValue(contactRecord, contactHeaders, contactRow, ["ประเภทลูกค้า"], -1),
        topic: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.TOPIC),
        priority: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.PRIORITY),
        siteType: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.SITE_TYPE),
        siteAddress: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.SITE_ADDRESS),
        location: getContactLocationValue(contactRow, contactLocationRichTextRow),
        province: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.PROVINCE),
        interests: getRecordValue(contactRecord, contactHeaders, contactRow, ["สินค้าที่สนใจ"], -1),
        jobDetails: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.JOB_DETAILS),
        budget: getRecordValue(contactRecord, contactHeaders, contactRow, ["งบประมาณ"], -1),
        salesperson: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.SALESPERSON),
        company: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.COMPANY),
        remarks: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.REMARKS),
        chatLink: getContactCaseValue(contactRow, CONTACT_CASE_COLUMNS.CHAT_LINK),
        link: getRecordValue(contactRecord, contactHeaders, contactRow, ["ลิงก์", "Link", "URL"], -1)
      });
    });
  }
  timeline.sort(function(a, b) {
    return getDateTimestamp(b.date) - getDateTimestamp(a.date);
  });

  var response = {
    success: true,
    lead: customerListItemFromRow(customerRow, customerIndices, timeline.length),
    cacheVersion: cacheVersion,
    apiVersion: GOOD_CRM_API_VERSION
  };
  response.lead["ไทม์ไลน์สถานะ"] = timeline;
  cacheLeadResponse(cacheKey, response);
  return response;
}

function getHeaders(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn === 0) return [];
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function(h) {
    return h.toString().trim();
  });
}

function rowObjectFromHeaders(headers, row) {
  var record = {};
  headers.forEach(function(header, index) {
    if (header) record[header] = row[index];
  });
  return record;
}

function getContactCaseValue(row, columnIndex) {
  return columnIndex >= 0 && columnIndex < row.length ? row[columnIndex] : "";
}

function setContactCaseValue(row, columnIndex, value) {
  while (row.length <= columnIndex) row.push("");
  row[columnIndex] = value;
}

function getContactLocationValue(row, richTextRow) {
  var richTextValue = richTextRow && richTextRow[CONTACT_CASE_COLUMNS.LOCATION];
  var richTextUrl = richTextValue && typeof richTextValue.getLinkUrl === "function"
    ? richTextValue.getLinkUrl()
    : "";
  return richTextUrl || getContactCaseValue(row, CONTACT_CASE_COLUMNS.LOCATION);
}

function getRecordValue(record, headers, row, headerNames, fallbackIndex) {
  for (var index = 0; index < headerNames.length; index++) {
    var headerName = headerNames[index];
    if (Object.prototype.hasOwnProperty.call(record, headerName)
      && String(record[headerName] == null ? "" : record[headerName]).trim() !== "") {
      return record[headerName];
    }
  }

  if (fallbackIndex >= 0 && fallbackIndex < row.length) return row[fallbackIndex];
  return "";
}

function getCustomerDetailsById(sheet) {
  var detailsById = {};
  if (!sheet || sheet.getLastRow() <= 1) return detailsById;

  var headers = getHeaders(sheet);
  var customerIdIndex = headers.indexOf("Cust_ID");
  if (customerIdIndex === -1) customerIdIndex = headers.indexOf("Cut_ID");
  var customerNameIndex = headers.indexOf("ชื่อลูกค้า");
  var customerPhoneIndex = headers.indexOf("เบอร์โทรศัพท์");
  if (customerIdIndex === -1) return detailsById;

  var customerRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getDisplayValues();
  customerRows.forEach(function(row) {
    var customerId = String(row[customerIdIndex] || "").trim();
    if (!customerId) return;
    detailsById[customerId] = {
      name: customerNameIndex === -1 ? "" : String(row[customerNameIndex] || "").trim(),
      phone: customerPhoneIndex === -1 ? "" : String(row[customerPhoneIndex] || "").trim()
    };
  });
  return detailsById;
}

function getDateTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  var timestamp = new Date(value || 0).getTime();
  return isNaN(timestamp) ? 0 : timestamp;
}

function setRowValue(headers, rowArray, headerName, value) {
  var index = headers.indexOf(headerName);
  if (index !== -1) {
    rowArray[index] = value;
  }
}

function updateCaseStatus(ss, data) {
  var caseId = String(data.caseId || "").trim();
  var status = String(data.status || "").trim();
  if (!caseId) throw new Error("ไม่พบ Case_ID ที่ต้องการอัปเดต");
  if (GOOD_CRM_CASE_STATUSES.indexOf(status) === -1) {
    throw new Error("สถานะงานไม่ถูกต้อง: " + status);
  }

  var sheet = ss.getSheetByName("ข้อมูลการติดต่อ");
  if (!sheet) throw new Error("Sheet 'ข้อมูลการติดต่อ' not found.");
  var headers = getHeaders(sheet);
  var caseIdIndex = headers.indexOf("Case_ID");
  if (caseIdIndex === -1) caseIdIndex = headers.indexOf("Log_ID");
  var statusIndex = headers.indexOf("สถานะงาน");
  var dateIndex = headers.indexOf("วันที่บันทึก");
  if (caseIdIndex === -1 || statusIndex === -1) {
    throw new Error("ไม่พบหัวคอลัมน์ Case_ID หรือสถานะงาน");
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) throw new Error("ไม่พบเคส " + caseId);
    var caseIds = sheet.getRange(2, caseIdIndex + 1, lastRow - 1, 1).getDisplayValues();
    var rowNumber = -1;
    for (var index = caseIds.length - 1; index >= 0; index--) {
      if (String(caseIds[index][0] || "").trim() === caseId) {
        rowNumber = index + 2;
        break;
      }
    }
    if (rowNumber === -1) throw new Error("ไม่พบเคส " + caseId);

    var updatedAt = new Date();
    sheet.getRange(rowNumber, statusIndex + 1).setValue(status);
    if (dateIndex !== -1) sheet.getRange(rowNumber, dateIndex + 1).setValue(updatedAt);
    SpreadsheetApp.flush();
    invalidateLeadCaches();

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      caseId: caseId,
      status: status,
      updatedAt: updatedAt,
      apiVersion: GOOD_CRM_API_VERSION
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function updateCaseDetails(ss, data) {
  var caseId = String(data.caseId || "").trim();
  var status = String(data.status || "").trim();
  if (!caseId) throw new Error("ไม่พบ Case_ID ที่ต้องการแก้ไข");
  if (!String(data.topic || "").trim() || !String(data.company || "").trim()) {
    throw new Error("กรุณาระบุหัวข้อที่ติดต่อและบริษัท");
  }
  if (GOOD_CRM_CASE_STATUSES.indexOf(status) === -1) {
    throw new Error("สถานะงานไม่ถูกต้อง: " + status);
  }

  var sheet = ss.getSheetByName("ข้อมูลการติดต่อ");
  if (!sheet) throw new Error("Sheet 'ข้อมูลการติดต่อ' not found.");
  // The contact sheet's case fields have a fixed A-R layout.  Do not depend on
  // editable header text here, otherwise a renamed header can make a save look
  // successful while leaving the intended cell unchanged.
  var headers = getHeaders(sheet);
  var caseIdIndex = CONTACT_CASE_COLUMNS.CASE_ID;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error("มีการบันทึกรายการอื่นอยู่ กรุณาลองใหม่อีกครั้ง");
  }
  try {
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) throw new Error("ไม่พบเคส " + caseId);
    var caseIds = sheet.getRange(2, caseIdIndex + 1, lastRow - 1, 1).getDisplayValues();
    var rowNumber = -1;
    for (var index = caseIds.length - 1; index >= 0; index--) {
      if (String(caseIds[index][0] || "").trim() === caseId) {
        rowNumber = index + 2;
        break;
      }
    }
    if (rowNumber === -1) throw new Error("ไม่พบเคส " + caseId);

    var columnCount = Math.max(sheet.getLastColumn(), CONTACT_CASE_COLUMNS.REMARKS + 1);
    while (headers.length < columnCount) headers.push("");
    var linkIndex = headers.indexOf("ลิงก์");
    if (String(data.link || "").trim() && linkIndex === -1) {
      sheet.getRange(1, columnCount + 1).setValue("ลิงก์");
      headers.push("ลิงก์");
      linkIndex = columnCount;
      columnCount += 1;
    }
    var row = sheet.getRange(rowNumber, 1, 1, columnCount).getValues()[0];
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.TOPIC, String(data.topic || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.PRIORITY, String(data.priority || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.SITE_TYPE, String(data.siteType || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.SITE_ADDRESS, String(data.siteAddress || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.PROVINCE, String(data.province || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.JOB_DETAILS, String(data.jobDetails || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.ADMIN, String(data.admin || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.SALESPERSON, String(data.salesperson || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.COMPANY, String(data.company || "").trim());
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.STATUS, status);
    setContactCaseValue(row, CONTACT_CASE_COLUMNS.REMARKS, String(data.remarks || "").trim());

    // These legacy optional fields do not have a fixed column in the requested
    // A-R layout, so retain their header-based mapping when that column exists.
    setRowValue(headers, row, "สินค้าที่สนใจ", String(data.interests || "").trim());
    setRowValue(headers, row, "งบประมาณ", String(data.budget || "").trim());
    if (linkIndex !== -1) row[linkIndex] = String(data.link || "").trim();

    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
    invalidateLeadCaches();

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      caseId: caseId,
      apiVersion: GOOD_CRM_API_VERSION
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function setCustomerRemarksByColumn(rowArray, value) {
  if (rowArray.length < CUSTOMER_REMARKS_COLUMN) {
    throw new Error("Column I for customer remarks was not found in sheet 'ข้อมูลลูกค้า'.");
  }
  rowArray[CUSTOMER_REMARKS_COLUMN - 1] = value;
}

function getPayloadText(data, fieldNames) {
  for (var i = 0; i < fieldNames.length; i++) {
    var fieldName = fieldNames[i];
    if (Object.prototype.hasOwnProperty.call(data, fieldName)) {
      return String(data[fieldName] == null ? "" : data[fieldName]).trim();
    }
  }
  return "";
}

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function formatThaiPhone(normalizedPhone) {
  var digits = normalizePhone(normalizedPhone).slice(0, 10);
  if (/^02\d{7}$/.test(digits)) {
    return digits.slice(0, 2) + "-" + digits.slice(2, 5) + "-" + digits.slice(5);
  }
  return digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6);
}

function isValidThaiPhone(phone) {
  var digits = normalizePhone(phone);
  return /^02\d{7}$/.test(digits) || /^0\d{9}$/.test(digits);
}

function customerSummaryFromRow(row, indices) {
  return {
    custId: String(row[indices.custId] || ""),
    customerName: String(row[indices.customerName] || ""),
    phone: String(row[indices.phone] || ""),
    gender: String(row[indices.gender] || "ไม่ระบุ"),
    contactChannel: String(row[indices.contactChannel] || ""),
    contactHandle: String(row[indices.contactHandle] || ""),
    referralDate: String(row[indices.referralDate] || ""),
    customerRemarks: String(row[indices.customerRemarks] || "")
  };
}

function getCustomerColumnIndices(sheet) {
  var headers = getHeaders(sheet);
  return {
    custId: headers.indexOf("Cust_ID"),
    customerName: headers.indexOf("ชื่อลูกค้า"),
    phone: headers.indexOf("เบอร์โทรศัพท์"),
    gender: headers.indexOf("เพศ"),
    contactChannel: headers.indexOf("ช่องทางติดต่อ"),
    contactHandle: headers.indexOf("ชื่อช่องทางติดต่อ"),
    referralDate: headers.indexOf("รู้จักครั้งแรก"),
    customerRemarks: sheet.getLastColumn() >= CUSTOMER_REMARKS_COLUMN ? CUSTOMER_REMARKS_COLUMN - 1 : -1
  };
}

function getCustomerRows(sheet) {
  if (sheet.getLastRow() <= 1) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
}

function findCustomerRowNumberById(sheet, custId) {
  var indices = getCustomerColumnIndices(sheet);
  if (indices.custId === -1) {
    throw new Error("Column 'Cust_ID' not found.");
  }

  var rows = getCustomerRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][indices.custId]).trim() === String(custId).trim()) {
      return i + 2;
    }
  }
  return -1;
}

function findCustomerByPhone(sheet, normalizedPhone) {
  var indices = getCustomerColumnIndices(sheet);
  if (indices.phone === -1) {
    throw new Error("Column 'เบอร์โทรศัพท์' not found.");
  }

  var rows = getCustomerRows(sheet);
  for (var i = 0; i < rows.length; i++) {
    if (normalizePhone(rows[i][indices.phone]) === normalizedPhone) {
      return customerSummaryFromRow(rows[i], indices);
    }
  }
  return null;
}

function lookupCustomers(sheet, customerName, phone) {
  var indices = getCustomerColumnIndices(sheet);
  if (indices.customerName === -1 || indices.phone === -1 || indices.customerRemarks === -1) {
    throw new Error("Required customer lookup columns not found.");
  }

  var normalizedName = String(customerName || "").trim().toLowerCase();
  var normalizedPhone = normalizePhone(phone);
  var nameMatches = [];
  var phoneMatches = [];
  var rows = getCustomerRows(sheet);

  rows.forEach(function(row) {
    var summary = customerSummaryFromRow(row, indices);
    if (normalizedName && summary.customerName.toLowerCase().indexOf(normalizedName) !== -1 && nameMatches.length < 5) {
      nameMatches.push(summary);
    }
    if (normalizedPhone && normalizePhone(summary.phone) === normalizedPhone) {
      phoneMatches.push(summary);
    }
  });

  return {
    nameMatches: nameMatches,
    phoneMatches: phoneMatches
  };
}

function generateId(sheet, prefix, colIndex) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return prefix + "0001";
  }
  
  var range = sheet.getRange(2, colIndex, lastRow - 1, 1);
  var values = range.getValues();
  
  var maxNum = 0;
  for (var i = 0; i < values.length; i++) {
    var val = values[i][0].toString();
    if (val.indexOf(prefix) === 0) {
      var numStr = val.substring(prefix.length);
      var num = parseInt(numStr, 10);
      if (!isNaN(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }
  
  var nextNum = maxNum + 1;
  var paddedNum = ("0000" + nextNum).slice(-4);
  return prefix + paddedNum;
}

function generateCaseId(sheet, headers) {
  var caseIdIndex = headers.indexOf("Case_ID");
  if (caseIdIndex === -1) {
    throw new Error("Column 'Case_ID' not found in sheet 'ข้อมูลการติดต่อ'.");
  }

  var timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var prefix = "CASE-" + Utilities.formatDate(new Date(), timeZone, "yyMMdd") + "-";
  var existingIds = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, caseIdIndex + 1, sheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) {
      existingIds[String(row[0] || "").trim().toUpperCase()] = true;
    });
  }

  for (var attempt = 0; attempt < 100; attempt++) {
    var suffix = Utilities.getUuid().replace(/-/g, "").slice(0, 3).toUpperCase();
    var candidate = prefix + suffix;
    if (!existingIds[candidate]) return candidate;
  }
  throw new Error("ไม่สามารถสร้าง Case_ID ที่ไม่ซ้ำได้");
}

function findRecentDuplicateCase(sheet, headers, data, custId, timestamp) {
  var caseIdIndex = headers.indexOf("Case_ID");
  var customerIdIndex = headers.indexOf("Cust_ID");
  if (customerIdIndex === -1) customerIdIndex = headers.indexOf("Cut_ID");
  var dateIndex = headers.indexOf("วันที่บันทึก");
  var topicIndex = headers.indexOf("หัวข้อที่ติดต่อ");
  var statusIndex = headers.indexOf("สถานะงาน");
  var addressIndex = headers.indexOf("ที่อยู่หน้างาน");
  if ([caseIdIndex, customerIdIndex, dateIndex, topicIndex, statusIndex, addressIndex].some(function(index) { return index === -1; })) {
    return null;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;
  var startRow = Math.max(2, lastRow - 24);
  var rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, sheet.getLastColumn()).getValues();
  var normalize = function(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  };
  var expectedCustomer = normalize(custId);
  var expectedTopic = normalize(data.topic);
  var expectedStatus = normalize(data.jobStatus);
  var expectedAddress = normalize(data.siteAddress);

  for (var index = rows.length - 1; index >= 0; index--) {
    var row = rows[index];
    var recordedAt = row[dateIndex] instanceof Date ? row[dateIndex] : new Date(row[dateIndex]);
    var isRecent = !isNaN(recordedAt.getTime()) && Math.abs(timestamp.getTime() - recordedAt.getTime()) <= 120000;
    if (isRecent
      && normalize(row[customerIdIndex]) === expectedCustomer
      && normalize(row[topicIndex]) === expectedTopic
      && normalize(row[statusIndex]) === expectedStatus
      && normalize(row[addressIndex]) === expectedAddress) {
      return { caseId: String(row[caseIdIndex] || "").trim(), rowNumber: startRow + index };
    }
  }
  return null;
}

function generateCustomerId(sheet) {
  var now = new Date();
  var timeZone = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var datePart = Utilities.formatDate(now, timeZone, "yyMMdd");
  var prefix = "CUST-" + datePart + "-";
  var lastRow = sheet.getLastRow();
  var existingIds = {};

  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    values.forEach(function(row) {
      existingIds[String(row[0] || "").trim().toUpperCase()] = true;
    });
  }

  // Three hexadecimal characters match the required format, e.g. 3C5 or A11.
  // Retry UUID-derived suffixes to guarantee that the generated ID is unique.
  for (var attempt = 0; attempt < 100; attempt++) {
    var suffix = Utilities.getUuid().replace(/-/g, "").slice(0, 3).toUpperCase();
    var candidate = prefix + suffix;
    if (!existingIds[candidate]) return candidate;
  }

  throw new Error("ไม่สามารถสร้าง Cust_ID ที่ไม่ซ้ำได้ กรุณาลองบันทึกอีกครั้ง");
}
