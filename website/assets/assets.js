(function () {
  var dataCache = null;
  var fetching = false;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderHeadquarters() {
    var target = document.getElementById('headquarters');
    var label = document.getElementById('headquarters-label');
    if (!target) return;

    if (!dataCache && !fetching) {
      fetching = true;
      fetch('./assets/business.json', { cache: 'no-cache' })
        .then(function (res) {
          if (!res.ok) throw new Error('Failed to fetch business.json');
          return res.json();
        })
        .then(function (data) {
          dataCache = data;
          fetching = false;
          applyData(target, label, dataCache);
        })
        .catch(function (err) {
          fetching = false;
          console.warn('Could not load business.json:', err);
        });
      return;
    }

    if (dataCache) {
      applyData(target, label, dataCache);
    }
  }

  function applyData(target, label, data) {
    var name = data['business-name'] || '';
    var address = data['business-address'] || '';
    if (label) label.textContent = 'Headquarters';
    target.innerHTML =
      '<strong>' + escapeHtml(name) + '</strong><br>' +
      escapeHtml(address).replace(/\n/g, '<br>');
  }

  function initObserver() {
    var observer = new MutationObserver(function () {
      // Re-apply whenever DOM changes (framework re-renders)
      renderHeadquarters();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // Initial run (in case element already exists)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      renderHeadquarters();
      initObserver();
    });
  } else {
    renderHeadquarters();
    initObserver();
  }
})();
