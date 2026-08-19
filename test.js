
    // State Variables
    let selectedTags = ["ฟิล์มกรองแสง", "ฟิล์มนิรภัย", "ฟิล์มตกแต่ง"];
    let config = {
      adminName: "คุณเก็ต",
      appsScriptUrl: "https://script.google.com/macros/s/AKfycbzJUk_Gtt_HygGSVz_qD_iKnFe8CzxaaZtQ6cwE22Pfp4B6VrdjfsFWqJcw9CkAzXTweg/exec"
    };
    let allLeads = []; // Store fetched leads
    let isSidebarCollapsed = false;
    let isMobileSidebarOpen = false;

    // Initialize App
    window.onload = function() {
      // Load configurations from LocalStorage
      const savedAdmin = localStorage.getItem("gfs_admin_name");
      const savedUrl = localStorage.getItem("gfs_apps_script_url");
      
      if (savedAdmin) config.adminName = savedAdmin;
      if (savedUrl) config.appsScriptUrl = savedUrl;
      
      document.getElementById("adminNameConfigSetting").value = config.adminName;
      document.getElementById("appsScriptUrlSetting").value = config.appsScriptUrl;
      
      updateAdminUI();
      
      // Default to "Overview" page
      switchPage('create-lead');
        fetchLeadsData();
      
      // Select Phone contact details label as initial state
      toggleChannelDetails('โทรศัพท์');

      // Check if draft exists
      checkDraft();
    };

    // Toggle Sidebar collapsed state (Desktop)
    function toggleSidebar() {
      isSidebarCollapsed = !isSidebarCollapsed;
      const sidebar = document.getElementById("sidebar");
      const brandText = document.getElementById("brandText");
      const toggleIcon = document.getElementById("toggleBtnIcon");
      const footerText = document.getElementById("sidebarFooterText");
      const labels = document.querySelectorAll(".sidebar-label");

      if (isSidebarCollapsed) {
        sidebar.className = "sidebar-transition w-20 bg-white border-r border-slate-200 flex flex-col shrink-0 relative z-20";
        brandText.style.display = "none";
        footerText.textContent = "v1.0";
        toggleIcon.className = "fa-solid fa-chevron-right text-xs";
        labels.forEach(lbl => lbl.style.display = "none");
      } else {
        sidebar.className = "sidebar-transition w-64 bg-white border-r border-slate-200 flex flex-col shrink-0 relative z-20";
        brandText.style.display = "block";
        footerText.textContent = "GOOD CRM Database v1.0.0";
        toggleIcon.className = "fa-solid fa-chevron-left text-xs";
        labels.forEach(lbl => lbl.style.display = "inline");
      }
    }

    // Toggle Mobile Sidebar Drawer
    function toggleMobileSidebar() {
      isMobileSidebarOpen = !isMobileSidebarOpen;
      const sidebar = document.getElementById("sidebar");
      const backdrop = document.getElementById("sidebarBackdrop");
      
      if (isMobileSidebarOpen) {
        sidebar.classList.remove("-translate-x-full");
        backdrop.classList.remove("hidden");
      } else {
        sidebar.classList.add("-translate-x-full");
        backdrop.classList.add("hidden");
      }
    }

    // Switch Page
    function switchPage(pageId) {
      // Hide all pages
      document.querySelectorAll(".page-container").forEach(el => el.classList.add("hidden"));
      
      // Show target page
      const targetPage = document.getElementById(`page-${pageId}`);
      if (targetPage) targetPage.classList.remove("hidden");
      
      // Remove active states from all sidebar buttons
      document.querySelectorAll("nav button").forEach(btn => {
        btn.className = "w-full group flex items-center px-3.5 py-3 rounded-xl transition-all duration-200 gap-3 font-semibold relative text-slate-500 hover:bg-slate-50 hover:text-blue-600";
      });
      
      // Set active state on target button
      const activeBtn = document.getElementById(`menu-${pageId}`);
      if (activeBtn) {
        activeBtn.className = "w-full group flex items-center px-3.5 py-3 bg-blue-600 text-white rounded-xl shadow-md shadow-blue-200 transition-all duration-200 gap-3 font-semibold relative";
      }

      // Close mobile drawer if switching page
      if (isMobileSidebarOpen) {
        toggleMobileSidebar();
      }

      // Fetch data automatically when switching to Overview or Leads list
      if (pageId === 'overview' || pageId === 'leads-list') {
        fetchLeadsData();
      }
    }

    // Fetch leads data from Google Sheet Web App
    async function fetchLeadsData() {
      if (!config.appsScriptUrl) {
        renderMockDataWarning();
        return;
      }
      
      try {
        const response = await fetch(`${config.appsScriptUrl}?action=getLeads`);
        const result = await response.json();
        
        if (result.success && result.leads) {
          allLeads = result.leads;
          updateDashboardStats();
          renderLeadsTable();
        } else {
          showToast(`ไม่สามารถดึงข้อมูลได้: ${result.error || "เกิดข้อผิดพลาด"}`);
          renderMockDataWarning();
        }
      } catch (err) {
        console.error("Fetch leads error:", err);
        renderMockDataWarning();
      }
    }

    // Displays warning and shows mock data when API URL is not set
    function renderMockDataWarning() {
      allLeads = [
        {
          "Cust_ID": "C-0001",
          "Log_ID": "L-0001",
          "วันที่บันทึก": new Date().toISOString(),
          "ชื่อลูกค้า": "คุณวิภาวี พงษ์สวัสดิ์",
          "ชื่อ/บริษัทออกบิล": "บริษัท ไบร์ท ดีเวลลอปเม้นท์ จำกัด",
          "เบอร์โทรศัพท์": "081-234-5678",
          "อีเมล": "wipavee@brightdev.co.th",
          "จังหวัด": "กรุงเทพมหานคร",
          "หัวข้อที่ติดต่อ": "ฟิล์มตกแต่ง (สินค้าที่สนใจ: ฟิล์มตกแต่ง)",
          "ประเภทหน้างาน": "อาคารสำนักงาน",
          "รู้จักครั้งแรก": new Date().toLocaleDateString('en-CA'),
          "ประเภทลูกค้า": "โครงการใหม่",
          "แอดมิน": "คุณเก็ต",
          "หมายเหตุ": "ความสำคัญ: สูง\
ฝ่ายขาย: ฝ่ายขาย 1\
สถานะงาน: รอดำเนินการ\
รายละเอียดงาน: ต้องการฟิล์มลดความร้อนสูง เน้นความใสภาพภายนอก\
\
หมายเหตุทั่วไป: ลูกค้าต้องการเปรียบเทียบหลายยี่ห้อ"
        }
      ];
      updateDashboardStats();
      renderLeadsTable();
    }

    function updateDashboardStats() {
      document.getElementById("statTotalLeads").textContent = allLeads.length;
      document.getElementById("statActiveLeads").textContent = Math.ceil(allLeads.length * 0.4);
      document.getElementById("statSuccessLeads").textContent = Math.floor(allLeads.length * 0.5);
    }

    function renderLeadsTable() {
      const tableBody = document.getElementById("leadsTableBody");
      tableBody.innerHTML = "";

      const recentBody = document.getElementById("recentLeadsTableBody");
      recentBody.innerHTML = "";
      
      if (allLeads.length === 0) {
        const emptyRow = `<tr><td colspan="7" class="p-8 text-center text-slate-400">ไม่มีข้อมูลลีดลูกค้าบันทึกอยู่ในระบบ</td></tr>`;
        tableBody.innerHTML = emptyRow;
        recentBody.innerHTML = `<tr><td colspan="4" class="py-6 text-center text-slate-400">ไม่มีข้อมูลลีด</td></tr>`;
        return;
      }
      
      allLeads.forEach(lead => {
        const dateFormatted = lead["วันที่บันทึก"] ? new Date(lead["วันที่บันทึก"]).toLocaleDateString('th-TH', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        }) : "-";
        
        const row = document.createElement("tr");
        row.className = "hover:bg-slate-50/80 transition-colors";
        row.innerHTML = `
          <td class="p-4 font-bold text-blue-700">${lead["Cust_ID"] || lead["Cut_ID"] || "-"}</td>
          <td class="p-4">
            <span class="font-bold text-slate-800 block">${lead["ชื่อลูกค้า"] || "-"}</span>
            <span class="text-xs text-slate-400 block text-ellipsis overflow-hidden max-w-[120px] sm:max-w-none">${lead["ชื่อ/บริษัทออกบิล"] || lead["บริษัท"] || "-"}</span>
          </td>
          <td class="p-4 text-xs space-y-0.5">
            <div class="text-slate-600"><i class="fa-solid fa-phone text-slate-400 mr-1.5 w-3.5"></i>${lead["เบอร์โทรศัพท์"] || "-"}</div>
            <div class="text-slate-400"><i class="fa-regular fa-envelope text-slate-400 mr-1.5 w-3.5"></i>${lead["อีเมล"] || "-"}</div>
          </td>
          <td class="p-4 font-semibold text-slate-600 hidden sm:table-cell">${lead["จังหวัด"] || "-"}</td>
          <td class="p-4 hidden md:table-cell">
            <div class="flex flex-wrap gap-1 max-w-[200px]">
              ${(lead["หัวข้อที่ติดต่อ"] || "").split(",").map(t => `<span class="bg-blue-50 text-blue-600 text-[10px] px-2 py-0.5 rounded-full font-semibold border border-blue-100">${t.trim()}</span>`).join('')}
            </div>
          </td>
          <td class="p-4 text-slate-500 font-medium hidden sm:table-cell">${dateFormatted}</td>
          <td class="p-4 text-center">
            <button onclick="viewLeadDetail('${lead["Cust_ID"]}')" class="px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 font-semibold rounded-lg text-xs transition-colors">
              <i class="fa-regular fa-eye mr-1"></i><span class="hidden sm:inline">ดูรายละเอียด</span><span class="inline sm:hidden">ดู</span>
            </button>
          </td>
        `;
        tableBody.appendChild(row);
      });

      allLeads.slice(0, 5).forEach(lead => {
        const row = document.createElement("tr");
        row.className = "hover:bg-slate-50 transition-colors";
        row.innerHTML = `
          <td class="py-3.5">
            <span class="font-bold text-slate-800 block">${lead["ชื่อลูกค้า"] || "-"}</span>
            <span class="text-xs text-slate-400 block">${lead["ชื่อ/บริษัทออกบิล"] || "-"}</span>
          </td>
          <td class="py-3.5 text-slate-600 text-xs">${lead["เบอร์โทรศัพท์"] || "-"}</td>
          <td class="py-3.5">
            <span class="bg-blue-50 text-blue-700 text-[10px] px-2 py-0.5 rounded-full font-semibold border border-blue-100">
              ${(lead["หัวข้อที่ติดต่อ"] || "").split(",")[0] || "-"}
            </span>
          </td>
          <td class="py-3.5 text-right font-bold text-blue-700 text-xs">${lead["Cust_ID"] || "-"}</td>
        `;
        recentBody.appendChild(row);
      });
    }

    // Filter Leads
    function filterLeads() {
      const search = document.getElementById("leadsSearchInput").value.toLowerCase().trim();
      const province = document.getElementById("filterProvince").value;
      const channel = document.getElementById("filterChannel").value;
      
      const tableRows = document.querySelectorAll("#leadsTableBody tr");
      
      allLeads.forEach((lead, idx) => {
        const matchesSearch = 
          (lead["ชื่อลูกค้า"] || "").toLowerCase().includes(search) ||
          (lead["ชื่อ/บริษัทออกบิล"] || "").toLowerCase().includes(search) ||
          (lead["เบอร์โทรศัพท์"] || "").toLowerCase().includes(search);
          
        const matchesProvince = !province || lead["จังหวัด"] === province;
        const matchesChannel = !channel || lead["ช่องทางติดต่อ"] === channel;
        
        const rowElement = tableRows[idx];
        if (rowElement) {
          if (matchesSearch && matchesProvince && matchesChannel) {
            rowElement.classList.remove("hidden");
          } else {
            rowElement.classList.add("hidden");
          }
        }
      });
    }

    // View Lead Detail
    function viewLeadDetail(custId) {
      const lead = allLeads.find(l => l["Cust_ID"] === custId);
      if (!lead) return;
      
      const content = document.getElementById("leadDetailContent");
      const refDateStr = lead["รู้จักครั้งแรก"] ? new Date(lead["รู้จักครั้งแรก"]).toLocaleDateString('th-TH') : "-";
      
      content.innerHTML = `
        <div class="grid grid-cols-2 gap-x-4 sm:gap-x-6 gap-y-4">
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">รหัสลูกค้า / รหัสการติดต่อ</span>
            <span class="font-bold text-blue-700 text-sm sm:text-md">${lead["Cust_ID"]} / ${lead["Log_ID"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">วันที่บันทึกเข้าระบบ</span>
            <span class="font-semibold text-slate-800">${new Date(lead["วันที่บันทึก"]).toLocaleString('th-TH')}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">ชื่อลูกค้า / ผู้ติดต่อ</span>
            <span class="font-bold text-slate-800 text-sm sm:text-md">${lead["ชื่อลูกค้า"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">ชื่อบริษัทออกบิล / บริษัท</span>
            <span class="font-bold text-slate-800">${lead["ชื่อ/บริษัทออกบิล"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">เบอร์โทรศัพท์</span>
            <span class="font-bold text-slate-800">${lead["เบอร์โทรศัพท์"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">เพศ</span>
            <span class="font-semibold text-slate-800">${lead["เพศ"] || "ไม่ระบุ"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">ช่องทางติดต่อหลักที่เข้ามา</span>
            <span class="font-semibold text-slate-800">${lead["ช่องทางติดต่อ"]} (${lead["ชื่อช่องทางติดต่อ"] || "-"})</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">รู้จักครั้งแรก (วันที่แรกพบ)</span>
            <span class="font-semibold text-slate-800">${refDateStr}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">ประเภทหน้างาน / สถานที่</span>
            <span class="font-semibold text-slate-800">${lead["ประเภทหน้างาน"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">จังหวัดหน้างาน</span>
            <span class="font-semibold text-slate-800">${lead["จังหวัด"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">ประเภทสินค้า/ความสนใจ</span>
            <span class="font-bold text-blue-700">${lead["หัวข้อที่ติดต่อ"] || "-"}</span>
          </div>
          <div>
            <span class="text-slate-400 text-[10px] sm:text-xs block mb-0.5">ประเภทลูกค้า</span>
            <span class="font-bold text-slate-800">${lead["ประเภทลูกค้า"] || "-"}</span>
          </div>
        </div>
        
        <div class="border-t border-slate-100 pt-4 text-xs sm:text-sm">
          <span class="text-slate-400 text-[10px] sm:text-xs block mb-1">ที่อยู่หน้างาน / ที่อยู่ออกบิล</span>
          <p class="text-slate-700 font-medium bg-slate-50 p-3 rounded-xl border border-slate-200/50">
            <b>ที่อยู่ติดตั้ง:</b> ${lead["ที่อยู่หน้างาน"] || "-"}<br>
            <b>เลขผู้เสียภาษี:</b> ${lead["เลขประจำตัวผู้เสียภาษี"] || "-"}<br>
            <b>ที่อยู่ออกบิล:</b> ${lead["ที่อยู่สำหรับออกบิล"] || "-"}
          </p>
        </div>

        <div class="border-t border-slate-100 pt-4 text-xs sm:text-sm">
          <span class="text-slate-400 text-[10px] sm:text-xs block mb-1">หมายเหตุระบบและรายละเอียดความต้องการ</span>
          <p class="text-slate-700 bg-slate-50 p-3 rounded-xl border border-slate-200/50 whitespace-pre-line font-medium leading-relaxed">${lead["หมายเหตุ"] || "-"}</p>
        </div>
        
        <div class="flex justify-between text-[10px] text-slate-400 pt-2">
          <span>ผู้ลงประวัติ: ${lead["แอดมิน"] || "-"}</span>
        </div>
      `;
      
      const modal = document.getElementById("leadDetailModal");
      modal.classList.remove("hidden");
      setTimeout(() => {
        modal.classList.remove("opacity-0");
        modal.querySelector("div").classList.remove("scale-95");
      }, 50);
    }

    function closeLeadDetailModal() {
      const modal = document.getElementById("leadDetailModal");
      modal.classList.add("opacity-0");
      modal.querySelector("div").classList.add("scale-95");
      setTimeout(() => {
        modal.classList.add("hidden");
      }, 300);
    }

    // Save Settings
    function saveGlobalSettings() {
      const adminVal = document.getElementById("adminNameConfigSetting").value.trim();
      const urlVal = document.getElementById("appsScriptUrlSetting").value.trim();
      
      if (!urlVal) {
        showToast("กรุณาระบุ Google Apps Script Web App URL");
        return;
      }
      
      config.adminName = adminVal || "คุณเก็ต";
      config.appsScriptUrl = urlVal;
      
      localStorage.setItem("gfs_admin_name", config.adminName);
      localStorage.setItem("gfs_apps_script_url", config.appsScriptUrl);
      
      updateAdminUI();
      showSuccessToast("บันทึกการตั้งค่าเรียบร้อยแล้ว");
      fetchLeadsData();
    }

    // Update Admin UI
    function updateAdminUI() {
      document.getElementById("headerAdminName").textContent = config.adminName;
      const initials = config.adminName.replace("คุณ", "").substring(0, 2);
      document.getElementById("userAvatarInitials").textContent = initials || "ก";
      
      // Update mobile avatar
      document.querySelector(".mobile-avatar-initials").textContent = initials || "ก";
      
      // Update form fields
      document.getElementById("adminName").value = config.adminName;
      document.getElementById("adminNameConfigSetting").value = config.adminName;
    }

    // Draft Functions
    function saveDraft() {
      const payload = getFormValues();
      localStorage.setItem('good_crm_draft', JSON.stringify(payload));
      showSuccessToast("บันทึกข้อมูลร่างชั่วคราวแล้ว");
      checkDraft();
    }

    function checkDraft() {
      const draft = localStorage.getItem('good_crm_draft');
      const banner = document.getElementById('draftRecoverAlert');
      if (draft) {
        banner.classList.remove('hidden');
      } else {
        banner.classList.add('hidden');
      }
    }

    function loadDraft() {
      const draftStr = localStorage.getItem('good_crm_draft');
      if (!draftStr) return;
      
      const data = JSON.parse(draftStr);
      
      document.getElementById("customerName").value = data.customerName || "";
      
      if (data.gender) {
        const rad = document.querySelector(`input[name="gender"][value="${data.gender}"]`);
        if (rad) rad.checked = true;
      }
      
      document.getElementById("phone").value = data.phone || "";
      document.getElementById("contactChannel").value = data.contactChannel || "";
      toggleChannelDetails(data.contactChannel || "");
      document.getElementById("contactHandle").value = data.contactHandle || "";
      document.getElementById("referralDate").value = data.referralDate || "";
      document.getElementById("customerRemarks").value = data.customerRemarks || "";
      document.getElementById("referralRemarks").value = data.referralRemarks || "";
      
      document.getElementById("adminName").value = data.adminName || config.adminName;
      document.getElementById("customerType").value = data.customerType || "";
      document.getElementById("topic").value = data.topic || "";
      document.getElementById("priority").value = data.priority || "ปานกลาง";
      document.getElementById("siteType").value = data.siteType || "";
      document.getElementById("siteAddress").value = data.siteAddress || "";
      document.getElementById("province").value = data.province || "กรุงเทพมหานคร";
      document.getElementById("goodsOfInterest").value = data.interests || "";
      document.getElementById("jobDetails").value = data.jobDetails || "";
      
      document.getElementById("billingName").value = data.billingName || "";
      document.getElementById("billingAddress").value = data.billingAddress || "";
      document.getElementById("taxId").value = data.taxId || "";
      document.getElementById("salesperson").value = data.salesperson || "";
      document.getElementById("jobStatus").value = data.jobStatus || "รอดำเนินการ";
      document.getElementById("billingRemarks").value = data.billingRemarks || "";
      
      showSuccessToast("โหลดข้อมูลร่างเรียบร้อยแล้ว");
      document.getElementById('draftRecoverAlert').classList.add('hidden');
    }

    function clearDraft() {
      localStorage.removeItem('good_crm_draft');
      checkDraft();
    }

    // Get form field values
    function getFormValues() {
      const genderRad = document.querySelector('input[name="gender"]:checked');
      return {
        adminName: document.getElementById("adminName").value,
        customerName: document.getElementById("customerName").value.trim(),
        gender: genderRad ? genderRad.value : "ไม่ระบุ",
        phone: document.getElementById("phone").value.trim(),
        contactChannel: document.getElementById("contactChannel").value,
        contactHandle: document.getElementById("contactHandle").value.trim(),
        referralDate: document.getElementById("referralDate").value,
        customerRemarks: document.getElementById("customerRemarks").value.trim(),
        referralRemarks: document.getElementById("referralRemarks").value.trim(),
        
        customerType: document.getElementById("customerType").value,
        topic: document.getElementById("topic").value.trim(),
        priority: document.getElementById("priority").value,
        siteType: document.getElementById("siteType").value,
        siteAddress: document.getElementById("siteAddress").value.trim(),
        province: document.getElementById("province").value,
        interests: document.getElementById("goodsOfInterest").value,
        jobDetails: document.getElementById("jobDetails").value.trim(),
        
        billingName: document.getElementById("billingName").value.trim(),
        billingAddress: document.getElementById("billingAddress").value.trim(),
        taxId: document.getElementById("taxId").value.trim(),
        salesperson: document.getElementById("salesperson").value,
        jobStatus: document.getElementById("jobStatus").value,
        billingRemarks: document.getElementById("billingRemarks").value.trim()
      };
    }

    // Toggle contact channel placeholder
        function selectChannel(channel, btn) {
      document.getElementById("contactChannel").value = channel;
      toggleChannelDetails(channel);
    }

    function toggleChannelDetails(channel) {
      const input = document.getElementById("contactHandle");
      
      document.querySelectorAll(".channel-btn").forEach(b => {
        if(b.dataset.value === channel) {
          b.classList.remove("bg-white", "text-slate-600", "border-slate-200");
          b.classList.add("bg-blue-50", "text-blue-700", "border-blue-300", "ring-1", "ring-blue-300");
        } else {
          b.classList.add("bg-white", "text-slate-600", "border-slate-200");
          b.classList.remove("bg-blue-50", "text-blue-700", "border-blue-300", "ring-1", "ring-blue-300");
        }
      });
      
      input.classList.remove("hidden");
      
      switch(channel) {
        case "Tel":
        case "โทรศัพท์":
          input.placeholder = "ชื่อไอดี/แอคเคาท์ (ถ้ามี)";
          break;
        case "Email":
        case "อีเมล":
          input.placeholder = "เช่น customer@email.com";
          break;
        case "Line":
        case "LINE":
          input.placeholder = "เช่น LINE ID หรือ LINE Name";
          break;
        case "FB":
        case "Facebook":
          input.placeholder = "ชื่อโปรไฟล์หรือลิงก์ Facebook";
          break;
        case "WalkIn":
          input.placeholder = "ระบุสาขาที่ติดต่อ (ถ้ามี)";
          break;
        case "Tiktok":
          input.placeholder = "ชื่อ Tiktok Account";
          break;
        default:
          input.placeholder = "ชื่อไอดี/แอคเคาท์ (ถ้ามี)";
          if(!channel) input.classList.add("hidden");
          break;
      }
    }

    // Custom Toast warnings
    function showToast(message) {
      const toast = document.getElementById("toast");
      const toastMessage = document.getElementById("toastMessage");
      
      toastMessage.textContent = message;
      toast.classList.remove("hidden");
      toast.classList.remove("bg-green-600");
      toast.classList.add("bg-red-600");
      
      setTimeout(() => {
        toast.classList.remove("opacity-0");
      }, 50);
      
      setTimeout(() => {
        toast.classList.add("opacity-0");
        setTimeout(() => {
          toast.classList.add("hidden");
        }, 300);
      }, 4000);
    }

    function showSuccessToast(message) {
      const toast = document.getElementById("toast");
      const toastMessage = document.getElementById("toastMessage");
      
      toastMessage.textContent = message;
      toast.classList.remove("hidden");
      toast.classList.remove("bg-red-600");
      toast.classList.add("bg-green-600");
      
      setTimeout(() => {
        toast.classList.remove("opacity-0");
      }, 50);
      
      setTimeout(() => {
        toast.classList.add("opacity-0");
        setTimeout(() => {
          toast.classList.add("hidden");
        }, 300);
      }, 3000);
    }

    // Modal control: Success
    function openSuccessModal(custId, logId) {
      document.getElementById("resCustId").textContent = custId;
      document.getElementById("resLogId").textContent = logId;
      
      const modal = document.getElementById("successModal");
      modal.classList.remove("hidden");
      setTimeout(() => {
        modal.classList.remove("opacity-0");
        modal.querySelector("div").classList.remove("scale-95");
      }, 50);
    }

    function closeSuccessModal() {
      const modal = document.getElementById("successModal");
      modal.classList.add("opacity-0");
      modal.querySelector("div").classList.add("scale-95");
      setTimeout(() => {
        modal.classList.add("hidden");
        resetForm();
        switchPage('leads-list');
      }, 300);
    }

    // Reset Form
    function resetForm() {
      document.getElementById("leadForm").reset();
      clearDraft();
      toggleChannelDetails('');
    }

    // Handle Form Submit and call Google Apps Script
    async function handleFormSubmit(e) {
      e.preventDefault();
      
      if (!config.appsScriptUrl) {
        showToast("กรุณาตั้งค่า Google Apps Script Web App URL ก่อนกดบันทึก (ไปที่เมนู 'ตั้งค่าระบบ')");
        switchPage('settings');
        return;
      }

      const values = getFormValues();
      const loading = document.getElementById("loadingOverlay");
      loading.classList.remove("hidden");

      try {
        const response = await fetch(config.appsScriptUrl, {
          method: "POST",
          mode: "cors",
          headers: {
            "Content-Type": "text/plain;charset=utf-8"
          },
          body: JSON.stringify(values)
        });

        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const result = await response.json();
        loading.classList.add("hidden");

        if (result.success) {
          clearDraft();
          openSuccessModal(result.custId, result.logId);
        } else {
          showToast(`เกิดข้อผิดพลาดในการบันทึก: ${result.error || "ไม่ทราบสาเหตุ"}`);
        }
        
      } catch (error) {
        loading.classList.add("hidden");
        console.error("Submission error:", error);
        showToast(`ไม่สามารถส่งข้อมูลได้: โปรดตรวจสอบสัญญาณเครือข่าย หรือลิงก์ Web App URL ว่าถูกต้องและเป็นสาธารณะหรือไม่`);
      }
    }
  