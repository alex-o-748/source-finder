#!/usr/bin/env python3
"""Assemble the tutorial: recorded scenes (screencast frames + timeline.json)
and still cards -> 30 fps clips -> crossfaded VP9 WebM, 1920x1080.

  python3 compose.py plan.json out/CNfirmed_tutorial.webm

plan.json: [{"frames": "takes/02-article"}, {"still": "out/card-title.png", "dur": 4.5}, ...]
A frames entry may carry "trim_start"/"trim_end" (seconds) and "speed" (e.g. 3
for a 3x fast-forward of the whole scene) or "speedup": [[from, to, factor]].
"""
import json, os, subprocess, sys

FPS = 30
XF = 0.4  # crossfade seconds
ROOT = os.path.dirname(os.path.abspath(__file__))


def run(cmd):
    print('+', ' '.join(cmd[:12]), '...' if len(cmd) > 12 else '')
    subprocess.run(cmd, check=True)


def retime(t, rel_speedups):
    """Map scene time t (from start) to output time with speed-up spans."""
    out = 0.0
    prev = 0.0
    for a, b, f in sorted(rel_speedups):
        if t <= a:
            break
        out += a - prev
        seg_end = min(t, b)
        out += (seg_end - a) / f
        prev = b
        if t <= b:
            return out
    return out + (t - prev)


def clip_from_frames(entry, out):
    d = os.path.join(ROOT, entry['frames'])
    tl = json.load(open(os.path.join(d, 'timeline.json')))
    t0 = tl['t0'] + entry.get('trim_start', 0)
    t_end = tl['tEnd'] - entry.get('trim_end', 0)
    frames = [f for f in tl['frames'] if f['t'] <= t_end]
    # the last frame at or before t0 starts the clip
    start = 0
    for k, f in enumerate(frames):
        if f['t'] <= t0:
            start = k
    frames = frames[start:]
    marks = tl.get('marks', {})
    shift = entry.get('trim_start', 0)
    speedups = [[(marks[a] if isinstance(a, str) else a) - shift, (marks[b] if isinstance(b, str) else b) - shift, f]
                for a, b, f in entry.get('speedup', [])]
    if entry.get('speed'):
        speedups = [[0, t_end - t0, entry['speed']]]
    times = [retime(max(0.0, f['t'] - t0), speedups) for f in frames]
    end = retime(t_end - t0, speedups)
    lst = out + '.txt'
    with open(lst, 'w') as fh:
        for k, f in enumerate(frames):
            nxt = times[k + 1] if k + 1 < len(frames) else end
            dur = max(nxt - times[k], 0.0)
            if dur <= 0 and k + 1 < len(frames):
                continue
            fh.write("file '%s'\nduration %.5f\n" % (os.path.join(d, f['file']), dur))
        fh.write("file '%s'\n" % os.path.join(d, frames[-1]['file']))
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst,
         '-vf', 'scale=1920:1080:flags=lanczos,fps=%d,format=yuv420p' % FPS, '-t', '%.3f' % end,
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '10', out])
    return end


def clip_from_still(entry, out):
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', str(FPS),
         '-i', os.path.join(ROOT, entry['still']), '-t', str(entry['dur']),
         '-vf', 'scale=1920:1080,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '10', out])
    return entry['dur']


def duration(path):
    r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                       capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def main(plan_path, out_path):
    plan = json.load(open(plan_path))
    work = os.path.join(ROOT, 'work')
    os.makedirs(work, exist_ok=True)
    clips = []
    for k, entry in enumerate(plan):
        out = os.path.join(work, 'clip%02d.mp4' % k)
        if 'frames' in entry:
            clip_from_frames(entry, out)
        else:
            clip_from_still(entry, out)
        clips.append((out, duration(out), entry.get('cut', False)))
        print('clip', k, '%.2fs' % clips[-1][1])

    inputs = []
    for c in clips:
        inputs += ['-i', c[0]]
    parts = []
    last = '[0:v]'
    t = clips[0][1]
    for k in range(1, len(clips)):
        xf = 0.04 if clips[k][2] else XF
        lab = '[v%d]' % k
        parts.append('%s[%d:v]xfade=transition=fade:duration=%.2f:offset=%.3f%s' % (last, k, xf, t - xf, lab))
        last = lab
        t = t - xf + clips[k][1]
    # fade in from / out to black, as a video file usually does
    parts.append('%sfade=t=in:st=0:d=0.5,fade=t=out:st=%.3f:d=0.6,format=yuv420p[vout]' % (last, t - 0.6))
    graph = ';'.join(parts)
    master = os.path.join(work, 'master.mp4')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + inputs +
        ['-filter_complex', graph, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-r', str(FPS), master])
    print('master %.2fs' % duration(master))
    common = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '31', '-row-mt', '1', '-tile-columns', '2',
              '-g', '240', '-pix_fmt', 'yuv420p', '-r', str(FPS)]
    passlog = os.path.join(work, 'vp9pass')
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', master] + common +
        ['-deadline', 'good', '-cpu-used', '4', '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'null', '/dev/null'])
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', master] + common +
        ['-deadline', 'good', '-cpu-used', '2', '-pass', '2', '-passlogfile', passlog, '-an',
         '-metadata', 'title=CNfirmed tutorial', out_path])
    print('wrote', out_path, '%.2fs' % duration(out_path), os.path.getsize(out_path) // 1024, 'KiB')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
