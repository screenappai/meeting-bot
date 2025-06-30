#!/bin/bash

export DISPLAY=:99

xvfb-run --server-num=99 --server-args='-screen 0 1280x720x24' npm run start
