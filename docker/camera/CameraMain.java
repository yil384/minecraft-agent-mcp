// docker/camera/CameraMain.java - starts the Minecraft client with its access token from the environment
// (MC_ACCESS_TOKEN) instead of the command line: a process's arguments are readable by every user of the machine
// (/proc/<pid>/cmdline), its environment only by its own user. Everything else is passed through to
// net.minecraft.client.main.Main (or Fabric's launcher, -Dagent.camera.main) unchanged. Without a token it does not
// start: the client runs only for a signed-in account that owns the game. Compiled in docker/Dockerfile.camera; no
// Minecraft classes at compile time.
// In a package of its own: the client jar is signed and its obfuscated classes live in the default package, which an
// unsigned class there would break ("signer information does not match").

package agent.camera;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class CameraMain {
  private CameraMain() {}

  public static void main(String[] args) throws Throwable {
    String token = System.getenv("MC_ACCESS_TOKEN");
    if (token == null || token.isBlank()) {
      System.err.println("CameraMain: no MC_ACCESS_TOKEN; the camera runs only with a signed-in Minecraft account (scripts/camera-login.mjs)");
      System.exit(2);
    }
    List<String> all = new ArrayList<>(Arrays.asList(args));
    all.add("--accessToken");
    all.add(token.trim());
    // the game's own main class, or Fabric's (KnotClient) when the camera runs with client mods (-Dagent.camera.main)
    Class<?> main = Class.forName(System.getProperty("agent.camera.main", "net.minecraft.client.main.Main"));
    try {
      main.getMethod("main", String[].class).invoke(null, (Object) all.toArray(new String[0]));
    } catch (java.lang.reflect.InvocationTargetException e) {
      throw e.getCause();
    }
  }
}
