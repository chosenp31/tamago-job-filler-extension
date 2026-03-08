document.addEventListener('DOMContentLoaded', () => {
  const btnCopy = document.getElementById('btn-copy');
  const btnPaste = document.getElementById('btn-paste');
  const btnClear = document.getElementById('btn-clear');
  const statusEl = document.getElementById('status');
  const storedInfo = document.getElementById('stored-info');
  const storedTitle = document.getElementById('stored-title');
  const storedFields = document.getElementById('stored-fields');

  let processing = false;

  // Check stored data on open
  chrome.storage.local.get('jobData', (result) => {
    if (result.jobData) {
      showStoredInfo(result.jobData);
    }
  });

  function showStoredInfo(jobData) {
    storedInfo.style.display = 'block';
    storedTitle.textContent = jobData.title || jobData.headline || '(タイトルなし)';
    const fieldCount = Object.entries(jobData)
      .filter(([k, v]) => v && k !== 'fullText')
      .length;
    storedFields.textContent = `取得済み項目: ${fieldCount}個`;
  }

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
  }

  function setProcessing(busy) {
    processing = busy;
    btnCopy.disabled = busy;
    btnPaste.disabled = busy;
    btnClear.disabled = busy;
  }

  // === COPY ===
  btnCopy.addEventListener('click', async () => {
    if (processing) return;
    setProcessing(true);
    showStatus('求人情報を読み取り中...', 'info');

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        showStatus('アクティブなタブが見つかりません。', 'error');
        return;
      }

      // chrome:// や edge:// 等の制限ページチェック
      if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://'))) {
        showStatus('このページでは実行できません。求人情報のページで実行してください。', 'error');
        return;
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractJobData
      });

      if (!results || !results[0]) {
        showStatus('ページの読み取りに失敗しました。ページを再読み込みしてから再度お試しください。', 'error');
        return;
      }

      const jobData = results[0].result;

      if (!jobData) {
        showStatus('ページの解析に失敗しました。', 'error');
        return;
      }

      if (jobData.error) {
        showStatus('エラー: ' + jobData.error, 'error');
        return;
      }

      // Check how many fields were extracted
      const filledFields = [];
      if (jobData.title) filledFields.push('タイトル');
      if (jobData.headline) filledFields.push('ヘッドライン');
      if (jobData.employmentType) filledFields.push('雇用形態');
      if (jobData.salaryMin || jobData.salaryMax) filledFields.push('給与');
      if (jobData.salaryDetails) filledFields.push('給与詳細');
      if (jobData.region) filledFields.push('勤務地');
      if (jobData.requirements) filledFields.push('応募資格');
      if (jobData.benefits) filledFields.push('福利厚生');
      if (jobData.jobDescription) filledFields.push('仕事内容');

      if (filledFields.length === 0) {
        showStatus('求人情報が見つかりませんでした。\n求人情報が表示されているページで実行してください。', 'error');
        return;
      }

      await chrome.storage.local.set({ jobData });
      showStoredInfo(jobData);

      const title = jobData.title || jobData.headline || '';
      const displayTitle = title.length > 20 ? title.substring(0, 20) + '...' : title;
      showStatus(
        `コピー完了: ${displayTitle}\n取得項目: ${filledFields.join(', ')}`,
        'success'
      );
    } catch (e) {
      if (e.message.includes('Cannot access')) {
        showStatus('このページでは実行できません。\n求人情報のページで実行してください。', 'error');
      } else {
        showStatus('エラー: ' + e.message, 'error');
      }
    } finally {
      setProcessing(false);
    }
  });

  // === PASTE ===
  btnPaste.addEventListener('click', async () => {
    if (processing) return;
    setProcessing(true);
    showStatus('フォームに入力中...', 'info');

    try {
      const stored = await chrome.storage.local.get('jobData');
      if (!stored.jobData) {
        showStatus('先に求人情報をコピーしてください。\n(手順1を先に実行)', 'error');
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab) {
        showStatus('アクティブなタブが見つかりません。', 'error');
        return;
      }

      const isTamago = tab.url && tab.url.includes('tamago-db.com');
      const isLocalTest = tab.url && (tab.url.startsWith('file://') || tab.url.includes('localhost'));

      if (!isTamago && !isLocalTest) {
        showStatus('Tamago-DBのページで実行してください。\n現在のページ: ' + (tab.url || '不明').substring(0, 50), 'error');
        return;
      }

      if (isTamago && !tab.url.includes('/job/new') && !tab.url.includes('/job/edit')) {
        showStatus('Tamago-DBの新規求人ページ（/job/new）で実行してください。', 'warning');
        // Don't return - allow paste on any tamago page in case URL structure changes
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: fillTamagoForm,
        args: [stored.jobData]
      });

      if (!results || !results[0]) {
        showStatus('フォームへの入力に失敗しました。\nページを再読み込みしてから再度お試しください。', 'error');
        return;
      }

      const report = results[0].result;

      if (report && report.error) {
        showStatus('エラー: ' + report.error, 'error');
        return;
      }

      if (report) {
        const lines = ['入力完了'];
        if (report.filled.length > 0) {
          lines.push('OK: ' + report.filled.join(', '));
        }
        if (report.skipped.length > 0) {
          lines.push('スキップ: ' + report.skipped.join(', '));
        }
        if (report.failed.length > 0) {
          lines.push('失敗: ' + report.failed.join(', '));
        }
        const type = report.failed.length > 0 ? 'warning' : 'success';
        showStatus(lines.join('\n'), type);
      } else {
        showStatus('フォームへの入力が完了しました。', 'success');
      }
    } catch (e) {
      showStatus('エラー: ' + e.message, 'error');
    } finally {
      setProcessing(false);
    }
  });

  // === CLEAR ===
  btnClear.addEventListener('click', async () => {
    if (processing) return;
    await chrome.storage.local.remove('jobData');
    storedInfo.style.display = 'none';
    showStatus('保存データをクリアしました。', 'info');
  });
});


// ==========================================
// Extract job data from the source page
// Runs in the context of the job posting page
// ==========================================
function extractJobData() {
  try {
    const text = document.body.innerText;

    if (!text || text.trim().length < 50) {
      return { error: 'ページの内容が少なすぎます。ページの読み込みが完了してから再度お試しください。' };
    }

    // Extract a section between startLabel and the nearest endLabel
    function extractSection(startLabels, endLabels) {
      const labels = Array.isArray(startLabels) ? startLabels : [startLabels];
      for (const label of labels) {
        const startIdx = text.indexOf(label);
        if (startIdx === -1) continue;

        const contentStart = startIdx + label.length;
        let endIdx = text.length;

        for (const endLabel of endLabels) {
          // Search for endLabel after contentStart, but skip if it's too close (< 2 chars)
          let searchFrom = contentStart;
          while (searchFrom < text.length) {
            const idx = text.indexOf(endLabel, searchFrom);
            if (idx === -1) break;
            // Ensure we don't match the same label position
            if (idx > contentStart + 1 && idx < endIdx) {
              endIdx = idx;
              break;
            }
            searchFrom = idx + 1;
          }
        }

        const value = text.substring(contentStart, endIdx).trim();
        if (value) return value;
      }
      return '';
    }

    // All possible section boundary labels (order matters for end detection)
    const boundaries = [
      '職種 / 募集ポジション', '職種/募集ポジション', '職種　/ 募集ポジション',
      '求人タイトル',
      '雇用形態',
      '給与',
      '勤務地',
      '応募資格',
      '福利厚生',
      '仕事についての詳細', '仕事の詳細',
      '仕事内容',
      'エージェント向け情報',
      '応募についての詳細',
      '会社についての詳細', '会社について',
      '企業情報',
      '選考プロセス'
    ];

    const title = extractSection(
      ['職種 / 募集ポジション', '職種/募集ポジション', '職種　/ 募集ポジション'],
      ['求人タイトル', '雇用形態', '給与', '勤務地', '応募資格']
    );

    const jobTitle = extractSection(
      ['求人タイトル'],
      ['雇用形態', '給与', '勤務地', '応募資格', '福利厚生']
    );

    const employmentType = extractSection(
      ['雇用形態'],
      ['給与', '勤務地', '応募資格', '福利厚生', '仕事内容']
    );

    const salaryRaw = extractSection(
      ['給与'],
      ['勤務地', '応募資格', '福利厚生', '仕事内容', '仕事についての詳細']
    );

    const location = extractSection(
      ['勤務地'],
      ['応募資格', '福利厚生', '仕事内容', '仕事についての詳細', 'エージェント向け情報']
    );

    const requirements = extractSection(
      ['応募資格'],
      ['福利厚生', '仕事内容', '仕事についての詳細', 'エージェント向け情報', '選考プロセス']
    );

    const benefits = extractSection(
      ['福利厚生'],
      ['仕事内容', '仕事についての詳細', 'エージェント向け情報', '応募についての詳細', '選考プロセス']
    );

    const jobDescription = extractSection(
      ['仕事内容'],
      ['エージェント向け情報', '応募についての詳細', '会社についての詳細', '会社について', '企業情報', '選考プロセス']
    );

    // --- Parse salary ---
    let salaryMin = '';
    let salaryMax = '';
    const salaryDetails = salaryRaw;

    // Pattern: "年収 4,000,000 円 - 12,000,000円" or "4,000,000円〜12,000,000円"
    let salaryMatch = salaryRaw.match(/(\d[\d,]+)\s*万?\s*円?\s*[-~〜―ー]+\s*(\d[\d,]+)/);
    if (salaryMatch) {
      salaryMin = salaryMatch[1].replace(/,/g, '');
      salaryMax = salaryMatch[2].replace(/,/g, '');

      // Check if values are in 万円 (e.g., "400万円 - 1200万円")
      if (salaryRaw.includes('万')) {
        if (parseInt(salaryMin) < 10000) salaryMin = String(parseInt(salaryMin) * 10000);
        if (parseInt(salaryMax) < 10000) salaryMax = String(parseInt(salaryMax) * 10000);
      }
    } else {
      // Try single value: "年収 500万円" etc.
      const singleMatch = salaryRaw.match(/(\d[\d,]+)\s*万?\s*円/);
      if (singleMatch) {
        salaryMin = singleMatch[1].replace(/,/g, '');
        if (salaryRaw.includes('万') && parseInt(salaryMin) < 10000) {
          salaryMin = String(parseInt(salaryMin) * 10000);
        }
      }
    }

    // --- Parse location ---
    let region = '';
    let city = '';

    // All 47 prefectures
    const prefectures = [
      '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
      '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
      '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
      '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
      '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
      '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
      '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'
    ];

    const locationText = location.split('\n')[0];
    for (const pref of prefectures) {
      // Match with or without 県/府/都
      const prefBase = pref.replace(/[都府県]$/, '');
      const patterns = [pref, prefBase + '都', prefBase + '府', prefBase + '県', prefBase];
      for (const p of patterns) {
        const idx = locationText.indexOf(p);
        if (idx !== -1) {
          region = pref;
          // Extract city: text after prefecture name
          const afterPref = locationText.substring(idx + p.length).trim();
          // Match city name (e.g., "大阪市", "新宿区", "渋谷区")
          const cityMatch = afterPref.match(/^(.+?[市区町村郡])/);
          if (cityMatch) {
            city = cityMatch[1];
          } else if (afterPref) {
            city = afterPref.split(/[、,\s]/)[0];
          }
          break;
        }
      }
      if (region) break;
    }

    return {
      title: title || jobTitle,
      headline: jobTitle || title,
      employmentType: employmentType.split('\n')[0].trim(),
      salaryMin,
      salaryMax,
      salaryDetails,
      region,
      city,
      locationRaw: location,
      requirements,
      benefits,
      jobDescription,
      sourceUrl: window.location.href,
      extractedAt: new Date().toISOString()
    };
  } catch (e) {
    return { error: 'ページの解析中にエラーが発生しました: ' + e.message };
  }
}


// ==========================================
// Fill Tamago-DB form with extracted job data
// Runs in the context of the Tamago-DB page
// ==========================================
function fillTamagoForm(data) {
  try {
    const report = { filled: [], skipped: [], failed: [] };

    // Check if the form exists
    const titleField = document.getElementById('JobType_title');
    if (!titleField) {
      return { error: '求人フォームが見つかりません。新規求人ページ（/job/new）を開いてください。' };
    }

    // Set value for input/textarea, handling CKEditor
    function setValue(id, value, label) {
      if (!value) {
        report.skipped.push(label);
        return false;
      }

      const el = document.getElementById(id);
      if (!el) {
        report.failed.push(label + '(要素なし)');
        return false;
      }

      try {
        if (el.tagName === 'TEXTAREA') {
          // Try CKEditor first
          let ckeSet = false;
          if (typeof CKEDITOR !== 'undefined') {
            // Try exact id match
            if (CKEDITOR.instances[id]) {
              CKEDITOR.instances[id].setData(value.replace(/\n/g, '<br>'));
              ckeSet = true;
            } else {
              // Search all instances for matching element
              for (const name in CKEDITOR.instances) {
                const inst = CKEDITOR.instances[name];
                if (inst.element && inst.element.getId && inst.element.getId() === id) {
                  inst.setData(value.replace(/\n/g, '<br>'));
                  ckeSet = true;
                  break;
                }
              }
            }
          }

          if (!ckeSet) {
            // Fallback: set textarea directly
            el.value = value;
          }
        } else if (el.tagName === 'INPUT') {
          // Use native setter to work with frameworks
          const nativeSetter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype, 'value'
          ).set;
          nativeSetter.call(el, value);
        }

        // Trigger events
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));

        report.filled.push(label);
        return true;
      } catch (e) {
        report.failed.push(label + '(' + e.message + ')');
        return false;
      }
    }

    // Set select value by matching option text
    function setSelectByText(id, searchText, label) {
      if (!searchText) {
        report.skipped.push(label);
        return false;
      }

      const el = document.getElementById(id);
      if (!el) {
        report.failed.push(label + '(要素なし)');
        return false;
      }

      try {
        const options = el.options;
        const normalizedSearch = searchText.trim().toLowerCase();

        // Exact match first
        for (let i = 0; i < options.length; i++) {
          if (options[i].textContent.trim().toLowerCase() === normalizedSearch) {
            el.value = options[i].value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof jQuery !== 'undefined') {
              try { jQuery('#' + id).val(options[i].value).trigger('change'); } catch(_) {}
            }
            report.filled.push(label);
            return true;
          }
        }

        // Partial match
        for (let i = 0; i < options.length; i++) {
          if (options[i].textContent.trim().toLowerCase().includes(normalizedSearch) ||
              normalizedSearch.includes(options[i].textContent.trim().toLowerCase())) {
            el.value = options[i].value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof jQuery !== 'undefined') {
              try { jQuery('#' + id).val(options[i].value).trigger('change'); } catch(_) {}
            }
            report.filled.push(label);
            return true;
          }
        }

        // Employment type special handling: try common mappings
        if (id === 'JobType_type') {
          const mappings = {
            '正社員': ['正社員', '常勤', 'full-time', 'permanent'],
            '契約社員': ['契約', 'contract'],
            '派遣社員': ['派遣', 'temporary', 'dispatch'],
            '業務委託': ['業務委託', 'freelance', 'outsource'],
            'パート': ['パート', 'part-time', 'アルバイト'],
            'インターン': ['インターン', 'intern']
          };

          for (const [key, aliases] of Object.entries(mappings)) {
            if (aliases.some(a => normalizedSearch.includes(a))) {
              for (let i = 0; i < options.length; i++) {
                const optText = options[i].textContent.trim().toLowerCase();
                if (optText.includes(key.toLowerCase()) || aliases.some(a => optText.includes(a))) {
                  el.value = options[i].value;
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                  if (typeof jQuery !== 'undefined') {
                    try { jQuery('#' + id).val(options[i].value).trigger('change'); } catch(_) {}
                  }
                  report.filled.push(label);
                  return true;
                }
              }
            }
          }
        }

        report.failed.push(label + '(選択肢なし)');
        return false;
      } catch (e) {
        report.failed.push(label + '(' + e.message + ')');
        return false;
      }
    }

    // Set salary basis select (年/月/日/時)
    function setSalaryBasis(id, salaryMin, label) {
      const el = document.getElementById(id);
      if (!el) return;

      try {
        const amount = parseInt(salaryMin);
        let basisText = '';
        if (amount >= 1000000) basisText = '年';
        else if (amount >= 100000) basisText = '月';
        else if (amount >= 5000) basisText = '日';
        else basisText = '時';

        for (let i = 0; i < el.options.length; i++) {
          if (el.options[i].textContent.trim().includes(basisText)) {
            el.value = el.options[i].value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof jQuery !== 'undefined') {
              try { jQuery('#' + id).val(el.options[i].value).trigger('change'); } catch(_) {}
            }
            return;
          }
        }
      } catch (_) {}
    }

    // --- Fill fields ---

    // Title
    setValue('JobType_title', data.title, 'タイトル');

    // Headline
    setValue('JobType_headline', data.headline, 'ヘッドライン');

    // Employment type
    if (data.employmentType) {
      setSelectByText('JobType_type', data.employmentType, '雇用タイプ');
      setValue('JobType_typeDetail', data.employmentType, '雇用タイプ詳細');
    } else {
      report.skipped.push('雇用タイプ');
    }

    // Salary min
    if (data.salaryMin) {
      setValue('JobType_wage_amount', data.salaryMin, '給与下限');
      setSalaryBasis('JobType_wage_basis', data.salaryMin);
    } else {
      report.skipped.push('給与下限');
    }

    // Salary max
    if (data.salaryMax) {
      setValue('JobType_maximumWage_amount', data.salaryMax, '給与上限');
      setSalaryBasis('JobType_maximumWage_basis', data.salaryMax || data.salaryMin);
    } else {
      report.skipped.push('給与上限');
    }

    // Salary details
    setValue('JobType_wageDetails', data.salaryDetails, '給与詳細');

    // Location
    if (data.region) {
      setValue('JobType_address_region', data.region, '都道府県');
    } else {
      report.skipped.push('都道府県');
    }
    if (data.city) {
      setValue('JobType_address_city', data.city, '市町村');
    } else {
      report.skipped.push('市町村');
    }

    // Requirements
    setValue('JobType_requirements', data.requirements, '応募資格');

    // Benefits
    setValue('JobType_benefits', data.benefits, '福利厚生');

    // Job description
    const descParts = [data.jobDescription];
    if (data.locationRaw && !data.jobDescription.includes(data.locationRaw.substring(0, 20))) {
      descParts.push('\n\n【勤務地詳細】\n' + data.locationRaw);
    }
    const fullDescription = descParts.filter(Boolean).join('');
    setValue('JobType_description', fullDescription, '仕事内容');

    // Visual feedback: highlight filled fields
    setTimeout(() => {
      const allFields = document.querySelectorAll(
        '#JobType_title, #JobType_headline, #JobType_typeDetail, ' +
        '#JobType_wage_amount, #JobType_maximumWage_amount, #JobType_wageDetails, ' +
        '#JobType_address_region, #JobType_address_city, ' +
        '#JobType_requirements, #JobType_benefits, #JobType_description'
      );
      allFields.forEach(el => {
        if (el && (el.value || (el.tagName === 'TEXTAREA' && el.value))) {
          el.style.transition = 'box-shadow 0.3s, border-color 0.3s';
          el.style.boxShadow = '0 0 0 2px #34a853';
          el.style.borderColor = '#34a853';
          setTimeout(() => {
            el.style.boxShadow = '';
            el.style.borderColor = '';
          }, 3000);
        }
      });
    }, 500);

    return report;
  } catch (e) {
    return { error: 'フォーム入力中にエラーが発生しました: ' + e.message };
  }
}
