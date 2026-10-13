# the camera is not near the bot any more: it went through a portal into another dimension, respawned far away, or was
# teleported. Start over at the bot: the old eye and the yaw marker go (in every dimension), the ride stops, the camera
# player is teleported to the bot (a teleport crosses dimensions), and the next lines of the tick make a new eye there
# and ask for the ride again. At most once every 2 s.
kill @e[type=minecraft:item_display,tag=agentcam_eye]
kill @e[type=minecraft:marker,tag=agentcam_yaw]
kill @e[type=minecraft:marker,tag=agentcam_orbit]
kill @e[type=minecraft:marker,tag=agentcam_spot]
kill @e[type=minecraft:marker,tag=agentcam_try]
scoreboard players set #on agentcam_y 0
execute as @a[tag=agentcam] run spectate
tag @a[tag=agentcam] remove agentcam_ineye
tag @a[tag=agentcam] remove agentcam_inhead
execute as @a[tag=agentcam] at @a[tag=agentcam_target,limit=1] run tp @s ~ ~2 ~
scoreboard players set #cd agentcam_cd 40
# the ride again from scratch a few times while the client loads the other dimension (agentcam:reride)
scoreboard players set #rr agentcam_rr 0
