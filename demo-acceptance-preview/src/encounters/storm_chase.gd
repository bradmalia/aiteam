# Storm chase controller
extends Node2D

@export var pursuit_speed: float = 236.0
@export var acceleration: float = 480.0
@export var camera_margin: float = 120.0

var pursuer_active: bool = false
var target: Node2D = null

func trigger_pursuit(p_target: Node2D) -> void:
    target = p_target
    pursuer_active = true

func _physics_process(delta: float) -> void:
    if pursuer_active and target != null:
        var dir = (target.global_position - global_position).normalized()
        global_position += dir * pursuit_speed * delta
