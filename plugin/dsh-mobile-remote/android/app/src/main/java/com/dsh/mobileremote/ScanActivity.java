package com.dsh.mobileremote;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.Toast;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.Result;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

/**
 * ScanActivity —— App 内嵌扫码（2026-09-22）。
 *
 * ══════════════════════════════════════════════════════════════════
 * v2：修复"扫不出来"（用户实测：首次配对在 App 里扫码永远失败）
 * ══════════════════════════════════════════════════════════════════
 * 三个叠加的真因，缺一个都解不出：
 * ① **旋转**：竖屏手机的后置相机传感器按横向输出帧（sensorOrientation≈90），
 *    画面里的二维码是**横着的** —— ZXing 解不出旋转 90° 的码。
 *    ⇒ 按传感器方向把亮度矩阵转正后再解码。
 * ② **rowStride**：YUV_420_888 的 Y 平面每行可能带 padding（rowStride ≥ width），
 *    直接整块 buffer 当 packed 数组用会错位 ⇒ 必须逐行拷贝。
 * ③ **对焦**：TEMPLATE_PREVIEW 默认不一定开连续对焦 ⇒ 近距离对二维码可能糊掉
 *    ⇒ 显式设 CONTROL_AF_MODE_CONTINUOUS_PICTURE。
 *
 * 另外解码时按 [首选旋转, +90, +180, +270] 的顺序都试一遍 —— 与其精确推导
 * 各机型的朝向组合，不如把四个方向都试掉（每 600ms 一帧，代价可接受）。
 */
public class ScanActivity extends Activity {

    private static final int REQ_CAMERA = 2001;

    private SurfaceView preview;
    private FrameLayout rootLayout;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private ImageReader reader;
    private HandlerThread bgThread;
    private Handler bg;
    private final MultiFormatReader decoder = new MultiFormatReader();
    private long lastDecodeAt = 0;
    private boolean done = false;
    private int sensorOrientation = 90;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        rootLayout = new FrameLayout(this);
        setContentView(rootLayout);

        preview = new SurfaceView(this);
        rootLayout.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        preview.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override public void surfaceCreated(SurfaceHolder h) { openCameraIfAllowed(); }
            @Override public void surfaceChanged(SurfaceHolder h, int f, int w, int ht) { }
            @Override public void surfaceDestroyed(SurfaceHolder h) { stopCamera(); }
        });

        Button cancel = new Button(this);
        cancel.setText("取消");
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM | android.view.Gravity.CENTER_HORIZONTAL);
        int m = (int) (24 * getResources().getDisplayMetrics().density);
        lp.setMargins(0, 0, 0, m);
        cancel.setOnClickListener(v -> finish());
        rootLayout.addView(cancel, lp);

        Toast.makeText(this, "对准电脑上的二维码；扫不了可返回后手输地址", Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        bgThread = new HandlerThread("scan");
        bgThread.start();
        bg = new Handler(bgThread.getLooper());
        if (preview.getHolder().getSurface() != null && preview.getHolder().getSurface().isValid()) {
            openCameraIfAllowed();
        }
    }

    @Override
    protected void onPause() {
        stopCamera();
        if (bgThread != null) { bgThread.quitSafely(); bgThread = null; }
        super.onPause();
    }

    private void openCameraIfAllowed() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openCamera();
        } else {
            requestPermissions(new String[]{ Manifest.permission.CAMERA }, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQ_CAMERA) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                openCamera();
            } else {
                Toast.makeText(this, "没有相机权限，无法扫码；返回后可手输地址", Toast.LENGTH_LONG).show();
            }
        } else {
            super.onRequestPermissionsResult(requestCode, permissions, results);
        }
    }

    private void openCamera() {
        CameraManager cm = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        try {
            String id = null;
            CameraCharacteristics chars = null;
            for (String cid : cm.getCameraIdList()) {
                CameraCharacteristics c = cm.getCameraCharacteristics(cid);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    id = cid; chars = c; break;
                }
            }
            if (id == null) {
                id = cm.getCameraIdList()[0];
                chars = cm.getCameraCharacteristics(id);
            }
            Integer so = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
            sensorOrientation = (so != null) ? so : 90;

            // 选一个受支持的 YUV 分析尺寸（贴着 1280×720 挑，挑不到就挑总面积最接近的）
            Size analysis = new Size(1280, 720);
            android.hardware.camera2.params.StreamConfigurationMap map =
                    chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map != null) {
                Size[] ys = map.getOutputSizes(ImageFormat.YUV_420_888);
                if (ys != null && ys.length > 0) {
                    long want = 1280L * 720L;
                    Size best = ys[0];
                    long bestDiff = Long.MAX_VALUE;
                    for (Size s : ys) {
                        long diff = Math.abs((long) s.getWidth() * s.getHeight() - want);
                        if (diff < bestDiff) { bestDiff = diff; best = s; }
                    }
                    analysis = best;
                }
            }

            reader = ImageReader.newInstance(analysis.getWidth(), analysis.getHeight(),
                    ImageFormat.YUV_420_888, 2);
            reader.setOnImageAvailableListener(imgReader -> {
                Image img = null;
                try {
                    img = imgReader.acquireLatestImage();
                    if (img == null || done) return;
                    long now = System.currentTimeMillis();
                    if (now - lastDecodeAt < 600) return;   // 节流：解码 4 个方向挺费 CPU
                    lastDecodeAt = now;
                    decode(img);
                } catch (Exception ignored) {
                } finally {
                    if (img != null) img.close();
                }
            }, bg);

            cm.openCamera(id, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice c) {
                    camera = c;
                    try {
                        Surface previewSurface = preview.getHolder().getSurface();
                        c.createCaptureSession(Arrays.asList(previewSurface, reader.getSurface()),
                            new CameraCaptureSession.StateCallback() {
                                @Override public void onConfigured(CameraCaptureSession s) {
                                    session = s;
                                    try {
                                        CaptureRequest.Builder rb =
                                                c.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                                        rb.addTarget(previewSurface);
                                        rb.addTarget(reader.getSurface());
                                        // ★ 连续对焦：不设的话近距扫码可能永远糊着
                                        rb.set(CaptureRequest.CONTROL_AF_MODE,
                                                CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                        s.setRepeatingRequest(rb.build(), null, bg);
                                    } catch (Exception e) {
                                        Toast.makeText(ScanActivity.this,
                                                "预览失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                                    }
                                }
                                @Override public void onConfigureFailed(CameraCaptureSession s) {
                                    Toast.makeText(ScanActivity.this, "相机配置失败", Toast.LENGTH_SHORT).show();
                                }
                            }, bg);
                    } catch (Exception e) {
                        Toast.makeText(ScanActivity.this,
                                "相机启动失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                    }
                }
                @Override public void onDisconnected(CameraDevice c) { c.close(); camera = null; }
                @Override public void onError(CameraDevice c, int error) { c.close(); camera = null; }
            }, bg);
        } catch (SecurityException se) {
            Toast.makeText(this, "没有相机权限", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "找不到可用相机：" + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    /** YUV 帧 → 亮度矩阵（处理 rowStride）→ 按 4 个方向尝试解码。 */
    private void decode(Image img) {
        Image.Plane p = img.getPlanes()[0];
        int w = img.getWidth(), h = img.getHeight();
        int rowStride = p.getRowStride(), pixelStride = p.getPixelStride();
        ByteBuffer buf = p.getBuffer();

        // 逐行拷出紧凑的 Y 矩阵（rowStride 可能 > width：行尾有 padding）
        byte[] y = new byte[w * h];
        try {
            if (pixelStride == 1) {
                for (int r = 0; r < h; r++) {
                    int off = r * rowStride;
                    if (off + w > buf.capacity()) break;
                    buf.position(off);
                    buf.get(y, r * w, w);
                }
            } else {
                // 罕见（Y 平面 pixelStride 通常为 1），保险起见仍支持
                for (int r = 0; r < h; r++) {
                    for (int c = 0; c < w; c++) {
                        int idx = r * rowStride + c * pixelStride;
                        if (idx >= buf.capacity()) break;
                        y[r * w + c] = buf.get(idx);
                    }
                }
            }
        } catch (Exception ignored) {
            return;
        }

        // 旋转顺序：按传感器方向推首选，然后其余三个方向兜底
        int displayDeg = 0;
        try {
            int rot = getWindowManager().getDefaultDisplay().getRotation();
            displayDeg = (rot == Surface.ROTATION_90) ? 90
                    : (rot == Surface.ROTATION_180) ? 180
                    : (rot == Surface.ROTATION_270) ? 270 : 0;
        } catch (Exception ignored) { }
        int first = (sensorOrientation - displayDeg + 360) % 360;

        int[] order = { first, (first + 90) % 360, (first + 180) % 360, (first + 270) % 360 };
        byte[] cur = y;
        int cw = w, ch = h;
        for (int i = 0; i < order.length && !done; i++) {
            int target = order[i];
            if (i > 0) {
                // 从上一个方向再顺时针转 90°（只实现一个旋转算子，靠迭代覆盖 4 个方向）
                cur = rotate90cw(cur, cw, ch);
                int t = cw; cw = ch; ch = t;
            }
            try {
                PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(
                        cur, cw, ch, 0, 0, cw, ch, false);
                Map<DecodeHintType, Object> hints = new HashMap<>();
                hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
                Result r = decoder.decode(new BinaryBitmap(new HybridBinarizer(src)), hints);
                if (r != null && !done) {
                    done = true;
                    Intent out = new Intent();
                    out.putExtra("text", r.getText());
                    setResult(RESULT_OK, out);
                    finish();
                    return;
                }
            } catch (Exception ignored) {
                // 这个方向没有码：正常，试下一个
            }
        }
    }

    /** 亮度矩阵顺时针转 90°：宽高互换。 */
    private static byte[] rotate90cw(byte[] in, int w, int h) {
        byte[] out = new byte[in.length];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                out[x * h + (h - 1 - y)] = in[y * w + x];
            }
        }
        return out;
    }

    private void stopCamera() {
        try { if (session != null) { session.close(); session = null; } } catch (Exception ignored) { }
        try { if (camera != null) { camera.close(); camera = null; } } catch (Exception ignored) { }
        try { if (reader != null) { reader.close(); reader = null; } } catch (Exception ignored) { }
    }
}
