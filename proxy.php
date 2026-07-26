<?php
/**
 * relay-usage 通用反代（解决 new-api 系 CORS 拦截）
 * 部署：上传到 NAS 上 php-comments-app 同目录（与 submit_comment.php 并排）
 * 页面站点编辑 → 代理前缀填：https://你的域名/proxy.php?u=
 *
 * 用法示例：页面请求 /api/user/self → 实际打到
 *   https://你的域名/proxy.php?u=https%3A%2F%2Fdocode.cc%2Fapi%2Fuser%2Fself
 * 反代服务会用 GET 参数里的 u 去目标站拉数据，原样返回。
 *
 * 关键：透传 Authorization 与 New-Api-User 头（new-api 自查 API 必需）
 */

// 1. CORS 头：让浏览器放行响应
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Authorization, New-Api-User, Content-Type, Accept');
header('Access-Control-Max-Age: 86400');

// 2. 预检请求直接 204
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

// 3. 解析目标 URL
$u = $_GET['u'] ?? '';
if (!$u || !preg_match('#^https://[A-Za-z0-9.\-]+(/[^\s]*)?$#', $u)) {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'bad target url']);
    exit;
}

// 4. 读出上游所需请求头（Apache 把自定义头转成 $_SERVER['HTTP_*']）
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$newApiUser = $_SERVER['HTTP_NEW_API_USER'] ?? '';
$upHeaders = ['Accept: application/json'];
if ($auth) $upHeaders[] = 'Authorization: ' . $auth;
if ($newApiUser) $upHeaders[] = 'New-Api-User: ' . $newApiUser;

// 5. cURL 转发
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $u,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT => 25,
    CURLOPT_HTTPHEADER => $upHeaders,
    CURLOPT_SSL_VERIFYPEER => true,
]);
$body = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err = curl_error($ch);
curl_close($ch);

header('Content-Type: application/json; charset=utf-8');
if ($body === false) {
    http_response_code(502);
    echo json_encode(['success' => false, 'message' => 'upstream error: ' . $err]);
    exit;
}
http_response_code($code);
echo $body;