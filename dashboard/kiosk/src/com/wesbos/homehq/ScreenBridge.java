package com.wesbos.homehq;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import java.io.BufferedReader;
import java.io.FileReader;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * window.HomeHQ for the dashboard page: screen off/on, Android Settings, ambient light.
 *
 * Only the saved dashboard's origin may use it: every call checks the main page's current origin
 * against the saved URL's origin and does nothing otherwise (other sites opened in the kiosk get
 * no bridge powers). Calls arrive on a WebView binder thread; UI work is posted to the main thread
 * and root commands run one at a time on a background thread.
 *
 * Screen off turns the panel's backlight off through the Allwinner display driver
 * (/sys/class/disp/disp/attr/lcdbl, 0-255) using the frame's setuid su, after saving the current
 * level, and covers the page with a black view. The first touch on that view turns the backlight
 * back on and is swallowed, so it can't press a button on the hidden page. Without su or lcdbl
 * (other frames, emulators) it falls back to window brightness 0 under the same black view.
 * The su commands are fixed strings plus an integer read from lcdbl itself; nothing from the page
 * reaches a shell.
 */
final class ScreenBridge implements SensorEventListener {
  static final String TAG = "HomeHQ";
  static final String LCDBL = "/sys/class/disp/disp/attr/lcdbl";
  static final String[] SU = {"/system/xbin/su", "/system/bin/su", "su"};

  interface UrlSource {
    String savedUrl();
  }

  private final Activity activity;
  private final WebView web;
  private final ViewGroup root;
  private final UrlSource urls;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final ExecutorService rootThread = Executors.newSingleThreadExecutor();

  private volatile String pageOrigin; // origin of the main page, set by the WebViewClient
  private volatile boolean off;
  private volatile float lux = -1f;
  private boolean sensorOn;
  private View blackout;
  private int savedLevel = -1; // lcdbl before screen off; -1 = not changed through root
  private boolean dimmedWindow; // fallback in use

  ScreenBridge(Activity activity, WebView web, ViewGroup root, UrlSource urls) {
    this.activity = activity;
    this.web = web;
    this.root = root;
    this.urls = urls;
  }

  /** Called on the main thread when the main frame starts loading a page. */
  void onPageStarted(String url) {
    pageOrigin = origin(url);
  }

  static String origin(String url) {
    if (url == null) return null;
    Uri u = Uri.parse(url);
    String scheme = u.getScheme(), host = u.getHost();
    if (scheme == null || host == null) return null;
    int port = u.getPort();
    if (port < 0) port = "https".equalsIgnoreCase(scheme) ? 443 : "http".equalsIgnoreCase(scheme) ? 80 : -1;
    return scheme.toLowerCase() + "://" + host.toLowerCase() + ":" + port;
  }

  private boolean allowed() {
    String page = pageOrigin;
    boolean ok = page != null && page.equals(origin(urls.savedUrl()));
    if (!ok) Log.w(TAG, "Bridge call refused for a page outside the dashboard origin");
    return ok;
  }

  // ------------------------------------------------------------ JavaScript API

  @JavascriptInterface
  public void openSettings() {
    if (!allowed()) return;
    ui.post(() -> {
      try {
        activity.startActivity(new Intent(Settings.ACTION_SETTINGS));
      } catch (Exception e) {
        Log.w(TAG, "No Settings app", e);
      }
    });
  }

  @JavascriptInterface
  public void screenOff() {
    if (!allowed()) return;
    ui.post(this::turnOff);
  }

  @JavascriptInterface
  public void screenOn() {
    if (!allowed()) return;
    ui.post(() -> turnOn(false));
  }

  @JavascriptInterface
  public boolean isScreenOff() {
    return allowed() && off;
  }

  /** Last ambient light reading in lux, or -1 before the first reading / without a sensor. */
  @JavascriptInterface
  public float lightLevel() {
    if (!allowed()) return -1f;
    ui.post(this::startSensor);
    return lux;
  }

  // ------------------------------------------------------------ screen

  private void turnOff() {
    if (off) return;
    off = true;
    showBlackout();
    rootThread.execute(() -> {
      int level = readLevel();
      boolean ok = level >= 0 && writeLevel(0) && readLevel() == 0;
      ui.post(() -> {
        if (ok) {
          savedLevel = level > 0 ? level : savedLevel;
          Log.i(TAG, "Backlight off (was " + level + ")");
        } else {
          Log.i(TAG, "No root backlight control, dimming the window instead");
          setWindowBrightness(0f);
          dimmedWindow = true;
        }
        if (!off) turnOn(false); // a touch arrived while the command ran
      });
    });
  }

  /** Main thread. fromTouch: the user woke it, so tell the page. */
  private void turnOn(boolean fromTouch) {
    if (blackout != null) {
      root.removeView(blackout);
      blackout = null;
    }
    boolean wasOff = off;
    off = false;
    if (dimmedWindow) {
      setWindowBrightness(WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE);
      dimmedWindow = false;
    }
    final int level = savedLevel;
    if (level > 0) {
      savedLevel = -1;
      rootThread.execute(() -> {
        if (!writeLevel(level)) Log.w(TAG, "Could not restore backlight level " + level);
      });
    }
    if (wasOff && fromTouch) {
      web.evaluateJavascript("window.onHomeHQScreen && window.onHomeHQScreen(false)", null);
    }
  }

  private void showBlackout() {
    if (blackout != null) return;
    blackout = new View(activity);
    blackout.setBackgroundColor(Color.BLACK);
    // Consume the whole gesture: the first touch only wakes the screen.
    blackout.setOnTouchListener((v, e) -> {
      if (e.getActionMasked() == MotionEvent.ACTION_DOWN) turnOn(true);
      return true;
    });
    root.addView(blackout, new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
  }

  private void setWindowBrightness(float value) {
    WindowManager.LayoutParams lp = activity.getWindow().getAttributes();
    lp.screenBrightness = value;
    activity.getWindow().setAttributes(lp);
  }

  /** Restore the screen when the kiosk goes away (main thread). */
  void release() {
    if (off) turnOn(false);
    if (sensorOn) {
      ((SensorManager) activity.getSystemService(Context.SENSOR_SERVICE)).unregisterListener(this);
      sensorOn = false;
    }
    rootThread.shutdown();
  }

  // ------------------------------------------------------------ backlight via root

  /** Current lcdbl level (the file is world-readable), or -1. */
  private static int readLevel() {
    try (BufferedReader r = new BufferedReader(new FileReader(LCDBL))) {
      String line = r.readLine();
      int v = line == null ? -1 : Integer.parseInt(line.trim());
      return v >= 0 && v <= 255 ? v : -1;
    } catch (Exception e) {
      return -1;
    }
  }

  /** Writes an integer level through su. The command is fixed text plus the integer. */
  private static boolean writeLevel(int level) {
    if (level < 0 || level > 255) return false;
    String cmd = "echo " + level + " > " + LCDBL;
    for (String su : SU) {
      try {
        Process p = Runtime.getRuntime().exec(new String[] {su, "-c", cmd});
        if (p.waitFor() == 0) return true;
      } catch (Exception e) {
        // try the next su path
      }
    }
    return false;
  }

  // ------------------------------------------------------------ light sensor

  private void startSensor() {
    if (sensorOn) return;
    SensorManager sm = (SensorManager) activity.getSystemService(Context.SENSOR_SERVICE);
    Sensor light = sm == null ? null : sm.getDefaultSensor(Sensor.TYPE_LIGHT);
    if (light == null) return;
    sensorOn = sm.registerListener(this, light, SensorManager.SENSOR_DELAY_NORMAL);
  }

  @Override
  public void onSensorChanged(SensorEvent event) {
    if (event.values.length > 0) lux = event.values[0];
  }

  @Override
  public void onAccuracyChanged(Sensor sensor, int accuracy) {}
}
