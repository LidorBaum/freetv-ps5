/* Copyright (C) 2026 John Törnblom
   Adapted for FreeTV, 2026.

This program is free software; you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the
Free Software Foundation; either version 3, or (at your option) any
later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; see the file COPYING. If not, see
<http://www.gnu.org/licenses/>.  */

/*
 * Install payload for the FreeTV web app.
 *
 * Writes webapp/ to /user/app/TITLE_ID/ next to the launcher metadata and
 * registers the title, so a FreeTV icon shows up on the Media tab. The
 * launcher's webAppUri (sce_sys/param.json) points the browser at that
 * directory as served by websrv on localhost:8080.
 */

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/uio.h>

#include <ps5/kernel.h>


#define IOVEC_SIZE(x) (sizeof(x) / sizeof(struct iovec))
#define IOVEC_ENTRY(x) {x ? x : 0, x ? strlen(x)+1 : 0}


#define INCASSET(name, file)			\
  __asm__(".section .rodata\n"			\
	  ".global " #name "\n"			\
	  ".global " #name "_end\n"		\
	  ".global " #name "_size\n"		\
	  ".align 16\n"				\
	  #name ":\n"				\
	  ".incbin \"" file "\"\n"		\
	  #name "_end:\n"			\
	  #name "_size:\n"			\
	  ".quad " #name "_end - " #name "\n"	\
	  ".previous\n");			\
  extern const uint8_t name[];			\
  extern const size_t name##_size;


int sceAppInstUtilInitialize(void);
int sceAppInstUtilAppInstallAll(void*);
int sceAppInstUtilAppUnInstall(const char*);


INCASSET(param_json, "sce_sys/param.json");
INCASSET(icon0_png, "sce_sys/icon0.png");
INCASSET(pic0_png, "sce_sys/pic0.png");
INCASSET(pic1_png, "sce_sys/pic1.png");
INCASSET(pic0_dds, "sce_sys/pic0.dds");
INCASSET(pic1_dds, "sce_sys/pic1.dds");

INCASSET(index_html, "webapp/index.html");
INCASSET(app_css, "webapp/app.css");
INCASSET(app_js, "webapp/app.js");
INCASSET(input_js, "webapp/input.js");
INCASSET(config_js, "webapp/config.js");
INCASSET(freetv_js, "webapp/freetv.js");
INCASSET(logo_png, "webapp/logo.png");
INCASSET(hls_js, "webapp/lib/hls.min.js");
INCASSET(shaka_js, "webapp/lib/shaka-player.compiled.js");
INCASSET(heebo_he_400, "webapp/fonts/heebo-hebrew-400.woff");
INCASSET(heebo_he_700, "webapp/fonts/heebo-hebrew-700.woff");
INCASSET(heebo_la_400, "webapp/fonts/heebo-latin-400.woff");
INCASSET(heebo_la_700, "webapp/fonts/heebo-latin-700.woff");


#define APP_DIR "/user/app/" TITLE_ID


typedef struct asset {
  const char* path;
  const uint8_t* data;
  const size_t* size;
} asset_t;


static const asset_t webapp[] = {
  {APP_DIR "/sce_sys/icon0.png", icon0_png, &icon0_png_size},
  // pic0 is the home screen background. The installer only registers it
  // (pic0Info in app.db) when a pic0.dds is present -- 3840x2160 BC7, as
  // games and other homebrew ship it -- so the PNGs alone show nothing.
  {APP_DIR "/sce_sys/pic0.png", pic0_png, &pic0_png_size},
  {APP_DIR "/sce_sys/pic1.png", pic1_png, &pic1_png_size},
  {APP_DIR "/sce_sys/pic0.dds", pic0_dds, &pic0_dds_size},
  {APP_DIR "/sce_sys/pic1.dds", pic1_dds, &pic1_dds_size},
  {APP_DIR "/sce_sys/param.json", param_json, &param_json_size},
  {APP_DIR "/index.html", index_html, &index_html_size},
  {APP_DIR "/app.css", app_css, &app_css_size},
  {APP_DIR "/app.js", app_js, &app_js_size},
  {APP_DIR "/input.js", input_js, &input_js_size},
  {APP_DIR "/config.js", config_js, &config_js_size},
  {APP_DIR "/freetv.js", freetv_js, &freetv_js_size},
  {APP_DIR "/logo.png", logo_png, &logo_png_size},
  {APP_DIR "/lib/hls.min.js", hls_js, &hls_js_size},
  {APP_DIR "/lib/shaka-player.compiled.js", shaka_js, &shaka_js_size},
  {APP_DIR "/fonts/heebo-hebrew-400.woff", heebo_he_400, &heebo_he_400_size},
  {APP_DIR "/fonts/heebo-hebrew-700.woff", heebo_he_700, &heebo_he_700_size},
  {APP_DIR "/fonts/heebo-latin-400.woff", heebo_la_400, &heebo_la_400_size},
  {APP_DIR "/fonts/heebo-latin-700.woff", heebo_la_700, &heebo_la_700_size},
};


static const char* app_dirs[] = {
  APP_DIR,
  APP_DIR "/sce_sys",
  APP_DIR "/lib",
  APP_DIR "/fonts",
};


static int
remount_system_ex(void) {
  struct iovec iov[] = {
    IOVEC_ENTRY("from"),      IOVEC_ENTRY("/dev/ssd0.system_ex"),
    IOVEC_ENTRY("fspath"),    IOVEC_ENTRY("/system_ex"),
    IOVEC_ENTRY("fstype"),    IOVEC_ENTRY("exfatfs"),
    IOVEC_ENTRY("large"),     IOVEC_ENTRY("yes"),
    IOVEC_ENTRY("timezone"),  IOVEC_ENTRY("static"),
    IOVEC_ENTRY("async"),     IOVEC_ENTRY(NULL),
    IOVEC_ENTRY("ignoreacl"), IOVEC_ENTRY(NULL),
  };

  return nmount(iov, IOVEC_SIZE(iov), MNT_UPDATE);
}


static int
make_dir(const char* path) {
  if(mkdir(path, 0755) && errno != EEXIST) {
    perror(path);
    return -1;
  }
  return 0;
}


static int
install_file(const char* path, const uint8_t* data, size_t size) {
  FILE* f;

  if(!(f=fopen(path, "w"))) {
    perror(path);
    return -1;
  }

  if(data && size) {
    if(fwrite(data, size, 1, f) != 1) {
      perror(path);
      fclose(f);
      return -1;
    }
  }

  fclose(f);
  return 0;
}


static int
install_app(const char* title_id, const char* dir) {
  int (*sceAppInstUtilAppInstallTitleDir)(const char*, const char*, void*) = 0;
  const char* nid = "Wudg3Xe3heE";
  uint32_t handle;

  if(!kernel_dynlib_handle(-1, "libSceAppInstUtil.sprx", &handle)) {
    sceAppInstUtilAppInstallTitleDir = (void*)kernel_dynlib_resolve(-1, handle, nid);
  }

  if(sceAppInstUtilAppInstallTitleDir) {
    return sceAppInstUtilAppInstallTitleDir(title_id, dir, 0);
  }

  return sceAppInstUtilAppInstallAll(0);
}


int
main(int argc, char *argv[]) {
  int err;

  puts("Installing FreeTV ("TITLE_ID")...");

  if((err=sceAppInstUtilInitialize())) {
    printf("sceAppInstUtilInitialize: error 0x%08X\n", err);
    return -1;
  }

  sceAppInstUtilAppUnInstall(TITLE_ID);

  //
  // The launcher entry: an empty eboot.bin and the param.json pointing the
  // browser at the web app.
  //

  remount_system_ex();

  if(make_dir("/system_ex/app/"TITLE_ID) ||
     make_dir("/system_ex/app/"TITLE_ID"/sce_sys")) {
    return -1;
  }
  if(install_file("/system_ex/app/"TITLE_ID"/eboot.bin", 0, 0) ||
     install_file("/system_ex/app/"TITLE_ID"/sce_sys/param.json",
		  param_json, param_json_size)) {
    return -1;
  }

  //
  // The web app itself, served by websrv out of /user/app.
  //

  for(size_t i=0; i<sizeof(app_dirs)/sizeof(app_dirs[0]); i++) {
    if(make_dir(app_dirs[i])) {
      return -1;
    }
  }

  for(size_t i=0; i<sizeof(webapp)/sizeof(webapp[0]); i++) {
    if(install_file(webapp[i].path, webapp[i].data, *webapp[i].size)) {
      return -1;
    }
  }

  if((err=install_app(TITLE_ID, "/user/app/"))) {
    printf("install_app: error 0x%08X\n", err);
    return -1;
  }

  puts("Install successful");

  return 0;
}
