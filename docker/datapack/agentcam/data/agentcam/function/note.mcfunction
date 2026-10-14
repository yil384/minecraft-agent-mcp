# the evidence of a camera spot, kept in storage agentcam:spot for the server log (the camera service asks the console
# for it after each new one: src/camera.js keepFollowingCommands): the rule that picked it (#rl: 1 the ring, 2 the
# nearest within 8 blocks, 3 from above, 5 the place from outside with no line to the shelter, 4 none outside, 11 the bot's eyes, 12 just ahead of them, 13 above its head,
# 14 and 15 behind it, 16 to 21 from above at an angle (agentcam:overhead), 22 behind it in a tunnel, 24 inside a shelter behind it (agentcam:inside); hidden 1 when no spot behind had seen the bot for a second, seen 1 when one sees it now),
# the eye and the bot (position, dimension, the bot's facing), and the blocks around as characters ("." open, "L"
# leaves, "#" anything else): col, the bot's column from its feet 24 blocks up; ring, the 8 blocks around its head
# then around its feet; eye, the eye's block and its 6 neighbours
execute store result storage agentcam:spot rule int 1 run scoreboard players get #rl agentcam_y
execute store result storage agentcam:spot time long 1 run time query gametime
execute store result storage agentcam:spot hidden int 1 run scoreboard players get #hd agentcam_y
execute store result storage agentcam:spot seen int 1 run scoreboard players get #vis agentcam_y
execute store result storage agentcam:spot fp int 1 if entity @a[tag=agentcam,tag=agentcam_fp]
data modify storage agentcam:spot eye set from entity @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] Pos
data modify storage agentcam:spot bot set from entity @a[tag=agentcam_target,limit=1] Pos
data modify storage agentcam:spot facing set from entity @a[tag=agentcam_target,limit=1] Rotation
data modify storage agentcam:spot dim set from entity @a[tag=agentcam_target,limit=1] Dimension
data modify storage agentcam:spot tmp set value []
execute at @a[tag=agentcam_target,limit=1] run function agentcam:note_col
data modify storage agentcam:spot col set from storage agentcam:spot tmp
data modify storage agentcam:spot tmp set value []
execute at @a[tag=agentcam_target,limit=1] run function agentcam:note_ring
data modify storage agentcam:spot ring set from storage agentcam:spot tmp
data modify storage agentcam:spot tmp set value []
execute at @e[type=minecraft:item_display,tag=agentcam_eye,limit=1] run function agentcam:note_eye
data modify storage agentcam:spot eyeb set from storage agentcam:spot tmp
data remove storage agentcam:spot tmp
scoreboard players add cam_seq agentcam_y 1
execute store result storage agentcam:spot seq int 1 run scoreboard players get cam_seq agentcam_y
