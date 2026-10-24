#!/usr/bin/env python3
"""Contact sheet of a take: python3 preview.py takes/article [every_s]"""
import sys, os, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import compose
take = sys.argv[1]; every = float(sys.argv[2]) if len(sys.argv) > 2 else 2
name = os.path.basename(take.rstrip('/'))
os.makedirs('work', exist_ok=True)
clip = 'work/prev-%s.mp4' % name
d = compose.clip_from_frames({'frames': take}, clip)
print('duration %.1fs' % d)
n = int(d // every) + 1
cols = 4; rows = (n + cols - 1) // cols
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', clip, '-vf',
    'fps=1/%g,scale=640:-1,drawtext=text=%%{pts\\\\:hms}:x=8:y=8:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.6,tile=%dx%d' % (every, cols, rows),
    '-frames:v', '1', 'out/sheet-%s.png' % name], check=True)
print('out/sheet-%s.png' % name)
