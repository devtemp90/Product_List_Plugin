// assets/sps-script.js
(function(){
  'use strict';

  // tiny helpers
  function debounce(fn, wait){ let t; return function(){ clearTimeout(t); t = setTimeout(()=>fn.apply(this, arguments), wait); }; }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function isVisible(el){ return el && (!!( el.offsetWidth || el.offsetHeight || el.getClientRects().length )); }
  function by(sel, root){ return (root||document).querySelector(sel); }
  function eachNode(sel, root, fn){ (root||document).querySelectorAll(sel).forEach(fn); }

  // ===== Inject Product Details Modal (global, once) =====
  // Inject before initWrapper runs so every wrapper can query it safely.
  document.addEventListener('DOMContentLoaded', function injectGlobalProductModal(){
    if (!document.querySelector('.sps-product-modal')) {
      const modalHTML = '\
        <div class="sps-product-modal" style="display:none">\
          <div class="sps-product-overlay" aria-hidden="true"></div>\
          <div class="sps-product-box" role="dialog" aria-modal="true">\
            <button type="button" class="sps-product-close" aria-label="Close">&times;</button>\
            <img id="sps-prod-img" src="" alt="">\
            <h3 id="sps-prod-title"></h3>\
            <p id="sps-prod-desc"></p>\
            <button type="button" id="sps-prod-enquire">Enquire</button>\
          </div>\
        </div>';
      document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    // After injecting, initialize wrappers
    document.querySelectorAll('.sps-wrapper').forEach(initWrapper);
  });

  // ---------- initWrapper ----------
  function initWrapper(wrapper){
    try {
      console.log('[SPS] init');

      // data attributes (set by PHP shortcode)
      var sheetUrl = wrapper.dataset.sheetUrl || '';
      var ajaxUrl  = wrapper.dataset.ajax || (window.ajaxurl || '/wp-admin/admin-ajax.php');
      var useProxy = wrapper.dataset.proxy === '1';
      var nonce    = wrapper.dataset.nonce || '';

      // main DOM pieces (page)
      var mainInput = by('.sps-input', wrapper);         // main page search (keeps existing)
      var results   = by('.sps-results', wrapper);       // cards container
      if (!results) {
        console.warn('[SPS] no .sps-results found in wrapper');
        return;
      }

      // enquiry modal (existing) - fallback creation
      var modal     = by('.sps-modal', wrapper);
      if (!modal) {
        modal = document.createElement('div'); modal.className = 'sps-modal'; modal.style.display='none';
        modal.innerHTML = '<div class="sps-modal-overlay"></div><div class="sps-modal-box"><button type="button" class="sps-modal-close" aria-label="Close">&times;</button><h3>Enquiry</h3><div class="sps-modal-body"></div></div>';
        wrapper.appendChild(modal);
      }
      var modalBox = by('.sps-modal-box', modal);
      var modalOverlay = by('.sps-modal-overlay', modal);
      var modalClose = by('.sps-modal-close', modal);
      var modalBody = by('.sps-modal-body', modal) || modalBox;
      var modalProductSearch = by('.sps-product-search', modal) || null;
      var suggestionsBox = by('.sps-suggestions', modal) || null;
      var chipsContainer = by('.sps-product-tags', modal) || null;
      var form = by('#sps-enquiry-form', modal) || null;

      if (!modalProductSearch) {
        modalProductSearch = document.createElement('input');
        modalProductSearch.className = 'sps-product-search';
        modalProductSearch.type = 'text';
        modalProductSearch.placeholder = 'Search products to add';
        modalBody.insertBefore(modalProductSearch, modalBody.firstChild);
      }
      if (!suggestionsBox) {
        suggestionsBox = document.createElement('div');
        suggestionsBox.className = 'sps-suggestions';
        suggestionsBox.style.position = 'relative';
        modalProductSearch.parentNode.insertBefore(suggestionsBox, modalProductSearch.nextSibling);
      }
      if (!chipsContainer) {
        chipsContainer = document.createElement('div');
        chipsContainer.className = 'sps-product-tags';
        chipsContainer.innerHTML = '<small>No products selected</small>';
        modalBody.insertBefore(chipsContainer, suggestionsBox.nextSibling);
      }
      if (!form) {
        form = document.createElement('form');
        form.id = 'sps-enquiry-form';
        form.innerHTML = ''
          + '<input type="hidden" name="action" value="sps_submit_enquiry">'
          + (nonce ? '<input type="hidden" name="nonce" value="'+escapeHtml(nonce)+'">' : '')
          + '<label>Name <input name="name" required></label>'
          + '<label>Email <input name="email" type="email" required></label>'
          + '<label>Message <textarea name="message"></textarea></label>'
          + '<button type="submit">Send enquiry</button>'
          + '<div class="sps-form-status" style="display:none"></div>';
        modalBody.appendChild(form);
      }

      // ensure hidden input[name="products"] exists
      var hiddenProductsInput = form.querySelector('input[name="products"]');
      if (!hiddenProductsInput) {
        hiddenProductsInput = document.createElement('input');
        hiddenProductsInput.type = 'hidden';
        hiddenProductsInput.name = 'products';
        hiddenProductsInput.value = '';
        form.insertBefore(hiddenProductsInput, form.firstChild);
      }

      var formStatus = form.querySelector('.sps-form-status') || (function(){ var s=document.createElement('div'); s.className='sps-form-status'; s.style.display='none'; form.appendChild(s); return s; })();

      // data arrays
      var products = [];         // all products from CSV (objects)
      var selected = [];         // selected product names in modal (strings)

      // ---------- CSV loader ----------
      function loadProductsCsv(url){
        return new Promise(function(resolve, reject){
          if (!url) { reject(new Error('No sheet URL')); return; }
          if (useProxy) {
            var proxy = ajaxUrl + '?action=sps_get_products&url=' + encodeURIComponent(url);
            console.log('[SPS] proxy fetch:', proxy);
            fetch(proxy, { credentials:'same-origin' })
              .then(r=>r.json()).then(j=>{ if (j.success) resolve(j.data); else reject(new Error('proxy error')); }).catch(reject);
            return;
          }
          var bust = url + (url.indexOf('?')>-1 ? '&' : '?') + 't=' + Date.now();
          console.log('[SPS] fetching CSV:', bust);
          fetch(bust, { cache:'no-store' })
            .then(r => { if (!r.ok) throw new Error('Network response not ok'); return r.text(); })
            .then(text => {
              console.log('[SPS] csv fetched length:', text.length);
              var parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
              var rows = (parsed.data || []).map(function(r){
                var obj = {};
                Object.keys(r).forEach(function(k){
                  var key = String(k||'').trim().toLowerCase().replace(/\s+/g,'_');
                  obj[key] = r[k] !== undefined && r[k] !== null ? String(r[k]).trim() : '';
                });
                return obj;
              }).filter(function(o){
                // keep rows that have any non-empty value
                return Object.values(o).some(v => v !== '');
              });
              console.log('[SPS] parsed rows count:', rows.length);
              resolve(rows);
            })
            .catch(reject);
        });
      }

      // initial load
      loadProductsCsv(sheetUrl).then(function(rows){
        products = rows || [];
        console.log('[SPS] products loaded:', products.length);
        // do NOT auto-render; wait for user input
      }).catch(function(err){
        console.error('[SPS] load error:', err);
        if (results) results.innerHTML = '<div class="sps-error">Could not load products</div>';
      });

      // ---------- MAIN page search (renders cards) ----------
      // ---------- MAIN page search (renders cards) ----------
function renderCards(list){
  if (!Array.isArray(list) || list.length === 0) {
    results.innerHTML = '<div class="sps-empty">No results found.</div>';
    return;
  }
  results.innerHTML = list.map(function(p, idx){
    var originalIndex = (p && (p._sps_index !== undefined)) ? p._sps_index : idx;
    var title = p.title || p.name || p.product || ('Product ' + (idx+1));
    var desc = p.description || p.details || '';
    var price = p.price || p.cost || '';
    var img = p.image || '';
    var imgHtml = img ? '<img class="sps-card-img" src="'+escapeHtml(img)+'" alt="'+escapeHtml(title)+'">' : '';
    var priceHtml = price ? '<div class="sps-price">'+escapeHtml(price)+'</div>' : '';
    return '<div class="sps-card" data-idx="'+originalIndex+'">'+
             imgHtml+
             '<div class="sps-card-body">'+
               '<h4 class="sps-title">'+escapeHtml(title)+'</h4>'+
               '<p class="sps-desc">'+escapeHtml((desc || '').slice(0,50))+'...</p>'+
               priceHtml+
               '<button type="button" class="sps-enquire-btn" data-product="'+escapeHtml(title)+'">Enquire</button>'+
             '</div></div>';
  }).join('');
}

// ---------- Skeletons ----------
function renderSkeletons(count){
  const skeletons = [];
  for (let i=0; i<count; i++){
    skeletons.push(`
      <div class="sps-card skeleton">
        <div class="sps-card-img"></div>
        <div class="sps-card-body">
          <div class="sps-title"></div>
          <div class="sps-desc"></div>
          <div class="sps-price"></div>
          <div class="sps-btn"></div>
        </div>
      </div>
    `);
  }
  results.innerHTML = skeletons.join('');
}

// main search
if (mainInput) {
  mainInput.addEventListener('input', debounce(function(){
    var q = mainInput.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ''; return; }

    renderSkeletons(4); // 👈 show skeletons while filtering

    var filtered = products.map(function(p,i){
      var wrapperObj = Object.assign({_sps_index: i}, p);
      return wrapperObj;
    }).filter(function(p){
      return Object.values(p).join(' ').toLowerCase().indexOf(q) !== -1;
    });

    setTimeout(function(){ renderCards(filtered); }, 400); // slight delay to simulate loading
  }, 200));
}


      // event-delegate enquire button clicks (cards -> add product + open modal)
      if (results) {
        results.addEventListener('click', function(ev){
          var btn = ev.target.closest('.sps-enquire-btn');
          if (btn) {
            var prod = btn.getAttribute('data-product') || '';
            if (!prod) return;
            addSelected(prod);
            openModal();
            return;
          }
        });
      }

      // ====== Product Details Modal logic (uses global modal injected earlier) ======
      try {
        const prodModal = document.querySelector('.sps-product-modal');
        if (prodModal && results) {
          const prodOverlay = prodModal.querySelector('.sps-product-overlay');
          const prodClose = prodModal.querySelector('.sps-product-close');
          const prodImg = document.getElementById('sps-prod-img');
          const prodTitle = document.getElementById('sps-prod-title');
          const prodDesc = document.getElementById('sps-prod-desc');
          const prodEnquireBtn = document.getElementById('sps-prod-enquire');

          // open product modal when product image clicked
          results.addEventListener('click', function(ev){
            // target the image inside card
            var imgEl = ev.target.closest('.sps-card img');
            if (!imgEl) return;
            var card = imgEl.closest('.sps-card');
            if (!card) return;
            var idxAttr = card.getAttribute('data-idx');
            var idx = parseInt(idxAttr, 10);
            if (Number.isNaN(idx)) return;
            var product = products[idx];
            if (!product) return;

            var title = product.title || product.name || product.product || '';
            var desc  = product.description || product.details || '';
            var img   = product.image || '';

            if (prodTitle) prodTitle.textContent = title;
            if (prodDesc) prodDesc.textContent = desc;
            if (prodImg) prodImg.src = img || '';

            prodModal.style.display = 'flex';
          });

          // close handlers
          if (prodClose) prodClose.addEventListener('click', function(){ prodModal.style.display = 'none'; });
          if (prodOverlay) prodOverlay.addEventListener('click', function(){ prodModal.style.display = 'none'; });

          // Enquire inside product modal -> add and open enquiry modal
          if (prodEnquireBtn) {
            prodEnquireBtn.addEventListener('click', function(){
              prodModal.style.display = 'none';
              // reuse existing functions (they exist later in this wrapper)
              addSelected(prodTitle ? prodTitle.textContent : '');
              openModal();
            });
          }
        }
      } catch (err) {
        console.warn('[SPS] product modal setup error', err);
      }

      // ---------- MODAL UI: suggestions, chips ----------
      function addSelected(name){
        name = String(name||'').trim();
        if (!name) return;
        if (selected.indexOf(name) !== -1) return;
        selected.push(name);
        renderChips();
      }
      function removeSelected(name){
        selected = selected.filter(function(x){ return x !== name; });
        renderChips();
      }
      function renderChips(){
        chipsContainer.innerHTML = '';
        if (!selected.length) {
          chipsContainer.innerHTML = '<small>No products selected</small>';
        } else {
          selected.forEach(function(p){
            var span = document.createElement('span');
            span.className = 'sps-tag';
            span.textContent = p;
            var x = document.createElement('button');
            x.type='button'; x.className='sps-tag-remove'; x.setAttribute('aria-label','Remove '+p); x.textContent='×';
            x.addEventListener('click', function(){ removeSelected(p); });
            span.appendChild(x);
            chipsContainer.appendChild(span);
          });
        }
        hiddenProductsInput.value = selected.join(', ');
        console.log('[SPS] selected:', selected);
      }

      // open/close enquiry modal
      function openModal(){ modal.style.display='flex'; setTimeout(()=>modal.classList.add('sps-open'), 10); modalProductSearch && modalProductSearch.focus(); }
      function closeModal(){ modal.classList.remove('sps-open'); setTimeout(()=>{ modal.style.display='none'; }, 180); }

      if (modalClose) modalClose.addEventListener('click', closeModal);
      if (modalOverlay) modalOverlay.addEventListener('click', closeModal);

      // modal search: show suggestions (max 8)
      function buildSuggestionItems(q){
        q = (q||'').trim().toLowerCase();
        if (!q) return [];
        var out = [];
        for (var i=0; i<products.length; i++){
          var p = products[i];
          var name = p.title || p.name || p.product || '';
          var desc = p.description || ''; // composition stored here
          if (!name && !desc) continue;
          if (name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
            out.push(name);
            if (out.length >= 8) break; // limit to 8 suggestions
          }
        }
        return out;
      }

      function showSuggestions(q){
        if (!suggestionsBox) return;
        var list = buildSuggestionItems(q);
        if (!list.length) { suggestionsBox.innerHTML = ''; return; }
        suggestionsBox.innerHTML = list.map(function(name){
          return '<div class="sps-suggestion" data-name="'+escapeHtml(name)+'">'+escapeHtml(name)+'</div>';
        }).join('');
      }

      // click on suggestion to add
      if (suggestionsBox) {
        suggestionsBox.addEventListener('click', function(ev){
          var el = ev.target.closest('.sps-suggestion'); if (!el) return;
          var name = el.getAttribute('data-name') || '';
          if (!name) return;
          addSelected(name);
          if (modalProductSearch) { modalProductSearch.value = ''; suggestionsBox.innerHTML = ''; modalProductSearch.focus(); }
        });
      }

      // modal input events
      if (modalProductSearch) {
        modalProductSearch.addEventListener('input', debounce(function(){
          var q = modalProductSearch.value.trim();
          showSuggestions(q);
        }, 160));

        // allow Enter to pick first suggestion
        modalProductSearch.addEventListener('keydown', function(e){
          if (e.key === 'Enter') {
            e.preventDefault();
            var first = suggestionsBox.querySelector('.sps-suggestion');
            if (first) {
              var name = first.getAttribute('data-name');
              addSelected(name);
              modalProductSearch.value = '';
              suggestionsBox.innerHTML = '';
            }
          }
        });
      }

      // ---------- FORM SUBMIT ----------
      form.addEventListener('submit', function(ev){
        ev.preventDefault();
        formStatus.style.display = 'none';
        // ensure hiddenProductsInput up-to-date
        hiddenProductsInput.value = selected.join(', ');
        var fd = new FormData(form);
        // debug: print FD entries
        console.log('[SPS] submit FormData:');
        for (var e of fd.entries()) { console.log(e[0], ':', e[1]); }

        fetch(ajaxUrl, { method:'POST', credentials:'same-origin', body: fd })
          .then(r => r.json())
          .then(function(json){
            formStatus.style.display = 'block';
            if (json.success) {
              formStatus.textContent = json.data.msg || 'Enquiry sent';
              formStatus.className = 'sps-form-status sps-success';
              form.reset();
              selected = []; renderChips();
              setTimeout(closeModal, 1200);
            } else {
              formStatus.textContent = (json.data && json.data.msg) ? json.data.msg : (json.message || 'Error');
              formStatus.className = 'sps-form-status sps-error';
            }
          })
          .catch(function(err){
            console.error('[SPS] submit error', err);
            formStatus.style.display='block';
            formStatus.textContent = 'Network error';
            formStatus.className = 'sps-form-status sps-error';
          });
      });

      // expose small helper to refresh products at runtime
      wrapper._sps_refresh = function(){
        loadProductsCsv(sheetUrl).then(r => {
          products = r||[];
          console.log('[SPS] refreshed', products.length);
          results.innerHTML = '';
        }).catch(console.error);
      };

    } catch (err) {
      console.error('[SPS] initWrapper error', err);
    }
  }

})(); // end IIFE
