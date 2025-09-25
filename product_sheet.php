<?php
/*
Plugin Name: Sheet Products Search
Description: Load products from a published Google Sheet CSV and show search + enquiry popup.
Version: 1.2
Author: Sahil Sharma
*/

if (!defined('ABSPATH')) exit;

function sps_enqueue_assets() {
    wp_register_style('sps-style', plugins_url('assets/sps-style.css', __FILE__));
    // PapaParse CDN
    wp_register_script('papaparse', 'https://cdn.jsdelivr.net/npm/papaparse@5.3.2/papaparse.min.js', array(), '5.3.2', true);
    wp_register_script('sps-script', plugins_url('assets/sps-script.js', __FILE__), array('papaparse'), '1.2', true);

    wp_enqueue_style('sps-style');
    wp_enqueue_script('papaparse');
    wp_enqueue_script('sps-script');
}
add_action('wp_enqueue_scripts', 'sps_enqueue_assets');

// Shortcode: [sheet_products_search data_url="CSV_URL"]
function sps_render_shortcode($atts){
    $atts = shortcode_atts(array('data_url' => '', 'proxy' => '0'), $atts);
    $data_url = esc_url($atts['data_url']);
    $proxy = $atts['proxy'] === '1' ? '1' : '0';
    if (empty($data_url)) return '<p><strong>Sheet products:</strong> No data_url provided.</p>';

    $nonce = wp_create_nonce('sps_enquiry_nonce');

    ob_start(); ?>
    <div class="sps-wrapper" 
         data-sheet-url="<?php echo esc_attr($data_url); ?>" 
         data-proxy="<?php echo $proxy; ?>" 
         data-ajax="<?php echo admin_url('admin-ajax.php'); ?>" 
         data-nonce="<?php echo $nonce; ?>">

      <div class="sps-search-bar">
        <input class="sps-input" type="search" placeholder="Search products..." aria-label="Search products">
      </div>
      <div class="sps-results" aria-live="polite"></div>

      <!-- Modal markup -->
      <div class="sps-modal" style="display:none;">
        <div class="sps-modal-overlay"></div>
        <div class="sps-modal-box">
          <button type="button" class="sps-modal-close">&times;</button>
          <h3>Enquiry</h3>

          <!-- search inside modal -->
          <input type="text" class="sps-product-search" placeholder="Search products to add">
          <div class="sps-suggestions"></div>

          <!-- chips container -->
          <div class="sps-product-tags"><small>No products selected</small></div>

          <form id="sps-enquiry-form">
    <input type="hidden" name="action" value="sps_submit_enquiry">
    <input type="hidden" name="nonce" value="<?php echo $nonce; ?>">
    <input type="hidden" name="products">
    <input type="text" name="name" placeholder="Your Name" required>
    <input type="email" name="email" placeholder="Your Email" required>
    <textarea name="message" placeholder="Message" required></textarea>
    <button type="submit">Send Enquiry</button>
    <div class="sps-form-status"></div>
</form>
        </div>
      </div>
    </div>
    <?php
    return ob_get_clean();
}
add_shortcode('sheet_products_search', 'sps_render_shortcode');

/**
 * AJAX handler for enquiry form submission
 */
/**
 * AJAX handler for enquiry form submission
 */
function sps_handle_enquiry() {
    // Safer nonce handling (no wp_die)
    if ( ! isset($_POST['nonce']) ) {
        wp_send_json_error(['msg' => 'Missing nonce']);
    }

    if ( ! wp_verify_nonce($_POST['nonce'], 'sps_enquiry_nonce') ) {
        wp_send_json_error([
            'msg'      => 'Invalid nonce',
            'received' => sanitize_text_field($_POST['nonce'])
        ]);
    }

    $name     = isset($_POST['name']) ? sanitize_text_field($_POST['name']) : '';
    $email    = isset($_POST['email']) ? sanitize_email($_POST['email']) : '';
    $message  = isset($_POST['message']) ? sanitize_textarea_field($_POST['message']) : '';
    $products = isset($_POST['products']) ? sanitize_text_field($_POST['products']) : '';

    if (empty($name) || empty($email) || empty($products)) {
        wp_send_json_error(['msg' => 'Please supply name, email and at least one product.']);
    }

    $to      = get_option('admin_email');  // change as needed
    $subject = "Product Enquiry from $name";
    $body    = "You have received a new enquiry:\n\n"
             . "Name: $name\n"
             . "Email: $email\n"
             . "Products: $products\n\n"
             . "Message:\n$message\n";

    $headers = [
        'Content-Type: text/plain; charset=UTF-8',
        'Reply-To: ' . $name . ' <' . $email . '>'
    ];

    if ( wp_mail($to, $subject, $body, $headers) ) {
        wp_send_json_success(['msg' => 'Your enquiry has been sent successfully!']);
    } else {
        wp_send_json_error(['msg' => 'Error sending email. Please try again.']);
    }
}
add_action('wp_ajax_sps_submit_enquiry', 'sps_handle_enquiry');
add_action('wp_ajax_nopriv_sps_submit_enquiry', 'sps_handle_enquiry');


/**
 * Optional server-side CSV proxy endpoint (useful if CORS fails).
 */
function sps_fetch_csv_proxy() {
    if ( ! isset($_GET['url']) ) {
        wp_send_json_error('Missing url');
    }
    $url = esc_url_raw($_GET['url']);
    if (empty($url)) wp_send_json_error('Invalid url');

    $cache_key = 'sps_csv_' . md5($url);
    $cached = get_transient($cache_key);
    if ($cached !== false) {
        wp_send_json_success($cached);
    }

    $resp = wp_remote_get($url, array('timeout'=>15));
    if (is_wp_error($resp)) wp_send_json_error($resp->get_error_message());

    $body = wp_remote_retrieve_body($resp);
    if (empty($body)) wp_send_json_success(array());

    // parse CSV to array
    $lines = preg_split("/\r\n|\n|\r/", trim($body));
    $header = array_map('trim', str_getcsv(array_shift($lines)));
    $header = array_map(function($h){ return sanitize_key(strtolower($h)); }, $header);

    $out = array();
    foreach ($lines as $ln) {
        if (trim($ln) === '') continue;
        $row = str_getcsv($ln);
        $obj = array();
        foreach ($header as $i => $h) {
            $obj[$h] = isset($row[$i]) ? $row[$i] : '';
        }
        $out[] = $obj;
    }
    set_transient($cache_key, $out, 5 * MINUTE_IN_SECONDS);
    wp_send_json_success($out);
}
add_action('wp_ajax_sps_get_products', 'sps_fetch_csv_proxy');
add_action('wp_ajax_nopriv_sps_get_products', 'sps_fetch_csv_proxy');