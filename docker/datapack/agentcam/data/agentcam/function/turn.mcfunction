# the orbit marker turned to the camera's yaw plus #rd (tenths of a degree): #oc
scoreboard players operation #oc agentcam_y = #c agentcam_y
scoreboard players operation #oc agentcam_y += #rd agentcam_y
scoreboard players operation #oc agentcam_y += #3600 agentcam_y
scoreboard players operation #oc agentcam_y %= #3600 agentcam_y
execute store result entity @e[type=minecraft:marker,tag=agentcam_orbit,limit=1] Rotation[0] float 0.1 run scoreboard players get #oc agentcam_y
