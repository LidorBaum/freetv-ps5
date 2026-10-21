#   Copyright (C) 2026 John Törnblom
#   Adapted for FreeTV, 2026.
#
# This file is free software; you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program; see the file COPYING. If not see
# <http://www.gnu.org/licenses/>.

PS5_HOST ?= ps5
PS5_PORT ?= 9021

# The title id must match sce_sys/param.json and be unique on the console.
TITLE_ID := BREW10972

ELF := freetv-install.elf

# Development only: where the app sends its diag lines, e.g.
#   make install LOG_SINK=http://192.168.1.10:8099/log
LOG_SINK ?=

ASSETS := $(wildcard sce_sys/*) $(wildcard webapp/*.html webapp/*.css \
	  webapp/*.js webapp/*.png webapp/lib/*.js webapp/fonts/*.woff) \
	  webapp/config.js

all: $(ELF)

# Rewritten only when LOG_SINK changes, so an unchanged build stays put.
webapp/config.js: FORCE
	@echo 'window.FREETV_LOG_SINK = "$(LOG_SINK)";' > $@.tmp
	@cmp -s $@.tmp $@ && rm $@.tmp || mv $@.tmp $@

ifdef PS5_PAYLOAD_SDK
include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk

CFLAGS := -Wall -Werror -g -DTITLE_ID="\"$(TITLE_ID)\""
LDADD  := -lSceIpmi -lSceAppInstUtil

$(ELF): main.c $(ASSETS)
	$(CC) $(CFLAGS) $(LDADD) -o $@ main.c

install: $(ELF)
	$(PS5_DEPLOY) -h $(PS5_HOST) -p $(PS5_PORT) $^

test: install
else
$(ELF) install test:
	$(error PS5_PAYLOAD_SDK is undefined)
endif

# Try the web app in a desktop browser. It must be http://localhost:8080:
# FreeTV's API echoes the origin back for CORS, and that is the origin the
# console uses too.
serve: webapp/config.js
	cd webapp && python3 -m http.server 8080 --bind 127.0.0.1

clean:
	rm -f $(ELF) webapp/config.js

FORCE:

.PHONY: all install test serve clean FORCE
